/**
 * Copyright (c) 2019, Regents of the University of Arizona.
 * Author: Chavoosh Ghasemi <chghasemi@cs.arizona.edu>
 *         Shaka Player project <https://github.com/google/shaka-player>
 *
 * You should have received a copy of the GNU General Public License along with
 * this script e.g., in COPYING.md file. If not, see <http://www.gnu.org/licenses/>.
 */

goog.require('goog.asserts');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.util.AbortableOperation');
goog.require('shaka.util.Error');

const HTTP_SUCCESS_CODE = 200;
const SESSION_NO = Math.floor(Math.random() * Math.pow(10, 12));
const SUPPORT_IN_BROWSER_CACHING = 'caches' in self;
const CACHE_NAME = 'ndn-video-cache';

var face = null;
var host = null;
var _cache = null;
var startTime = null;
var startupDelay = 0; // startup delay of the video

statsCode = {
  DONE: 1,
  ERROR: 2
};

console.log('sessions_id: ' + SESSION_NO);

async function queryCache(uri) {
  if (!SUPPORT_IN_BROWSER_CACHING)
    return null;

  _cache = await caches.open(CACHE_NAME);
  const options = {
    ignoreSearch: true,
    ignoreMethod: true,
    ignoreVary: true
  };
  const response = await _cache.match(uri, options);
  if (response !== undefined) {
    if (Log.LOG > 2)
      console.log(uri + ' is served from cache.');
    return response;
  }
  else
    return null;
}

async function addToCache(uri, response) {
  if (SUPPORT_IN_BROWSER_CACHING) {
    _cache = await caches.open(CACHE_NAME);
    _cache.put(uri, response);
  }
  else {
    return null;
  }
}

/**
 * @namespace
 * @summary A networking plugin to handle http and https URIs via NDN.
 * @param {string} uri
 * @param {shaka.extern.Request} request
 * @param {shaka.net.NetworkingEngine.RequestType} requestType
 * @param {function(number, number)=} progressUpdated Called when a progress
 *        event happened.
 * @return {!shaka.extern.IAbortableOperation.<shaka.extern.Response>}
 * @export
 */
shaka.net.HttpNdnPlugin = function(uri, request, requestType, progressUpdated) {
  if (typeof BASEPREFIX !== 'string' || BASEPREFIX.length == 0) {
    shaka.log.error('BASEPREFIX is not valid');
    return;
  }

  var promise = new Promise(function(resolve, reject) {
    // Check the cache first
    queryCache(uri).then(function(responseFromCache) {
      if (responseFromCache != null) {
        responseFromCache.arrayBuffer().then(function(buf) {
          var shakaResponse = shaka.net.HttpPluginUtils.makeResponse
            ({'x-shaka-from-cache': true}, buf, HTTP_SUCCESS_CODE, uri, null, requestType);
          resolve(shakaResponse);
        });
      }
      else {
        var parser = document.createElement('a');
        parser.href = uri;
        var name = parser.pathname;

        if (PORT === 443)
          host = 'wss://' + parser.host + '/ws/';
        else
          host = parser.host;

        if (face === null)
          face = new Face({host: host, port: PORT});

        var interest = new Interest(new Name(name));
        interest.setInterestLifetimeMilliseconds(1000);

        startTime = Date.now();
        var statsObj = {};
        SegmentFetcher.fetch(face, interest, null,
          function(content) { // onComplete
            var response = null;
            if (requestType < 4) { // manifest file
              response = shaka.net.HttpPluginUtils.makeResponse({} /*headers*/,
                  content.buf(), HTTP_SUCCESS_CODE,
                  uri, null, requestType);
            }
            else {
              shaka.log.debug('Uknown request type ' + requestType);
            }
            // send an Interest back for collecting stats
            var statsName = createStatsName(statsCode.DONE, name, startTime, host, statsObj);
            if (statsName !== "") {
              // create stats Interest
              var statsInterest = new Interest(statsName);
              // dummy Data will return to clear up the pit entries
              SegmentFetcher.fetch(face, statsInterest, null,
                function(content){}, function(errCode, message){},
                {pipeline: "cubic", maxRetriesOnTimeoutOrNack: 0}, null);
            }
            addToCache(uri, new Response(content.buf()));
            resolve(response);
          },
          function(errorCode, message) { // onError
            shaka.log.debug('Error ' + errorCode + ': ' + message);
            // send an Interest back for collecting stats
            var statsName = createStatsName(statsCode.ERROR, name, startTime, host, statsObj);
            if (statsName !== "") {
              // create stats Interest
              var statsInterest = new Interest(statsName);
              // dummy Data will return to clear up the pit entries
              SegmentFetcher.fetch(face, statsInterest, null,
                function(content){}, function(errCode, message){},
                {pipeline: "cubic", maxRetriesOnTimeoutOrNack: 0}, null);
            }
          },
          {pipeline: "cubic", maxRetriesOnTimeoutOrNack: 50},
          statsObj);
      }
    }); //-- queryCache
  }); //-- promise

  return new shaka.util.AbortableOperation(
   promise,
   () => {
      abortStatus.canceled = true;
      return Promise.resolve();
    });
};

/**
 * @summary Create an Interest name for collecting statistical info
 *
 * @param statCode 1: DONE | 2: ERROR
 * @param name The file name
 * @param startTime The starting time of file downloading
 * @param host The URL of NFD instance we are connecting to
 */
function createStatsName(statCode, name, startTime, host, stats) {
  var stat = 'DONE'; /* every code except 2 means success */
  if (statCode === 2) {
    stat = 'ERROR';
  }
  else if (statCode !== 1) {
    shaka.log.warning('WARNING: Unrecognized statCode', statCode);
  }

  var stats_ = window.player.getStats();
  var bandwidthEst = Math.round(stats_.estimatedBandwidth);
  var startupDelay =stats_.loadLatency;

  var rebufferingArray = [];
  var firstBuffering = true;
  for (var i = 0; i < stats_.stateHistory.length; ++i) {
    if (stats_.stateHistory[i].state === "buffering")
      if (firstBuffering == true) { //exclude startup buffering
        firstBuffering = false;
        continue;
      }
      rebufferingArray.push(i);
  }

  var statsName = new Name(BASEPREFIX_STATS + name.slice(BASEPREFIX.length))
                      .append('status=' + stat)
                      .append('hub=' + host.toString())
                      .append('ip=' + PUBLIC_IP_ADDRESS)
                      .append('estBw=' + bandwidthEst.toString())
                      .append('nRetransmissions=' + stats.nRetransmitted)
                      .append('nTimeouts=' + stats.nTimeouts)
                      .append('nNack=' + stats.nNacks)
                      .append('nSegments=' + stats.nSegments)
                      .append('delay=' + (Date.now() - startTime).toString())
                      .append('avgRtt=' + stats.avgRtt)
                      .append('avgJitter=' + stats.avgJitter)
                      .append('session=' + SESSION_NO)
                      .append('startupDelay=' + startupDelay)
                      .append('rebufferings=' + rebufferingArray.length);

  // append duration of bufferings
  for (i = 0; i < rebufferingArray.length; ++i) {
    statsName.append('bufferingDuration=' + stats_.stateHistory[rebufferingArray[i]].duration);
  }

  return statsName;
}

function registerPlugin() {
  shaka.net.NetworkingEngine.registerScheme('http', shaka.net.HttpNdnPlugin,
      shaka.net.NetworkingEngine.PluginPriority.PREFERRED);
  shaka.net.NetworkingEngine.registerScheme('https', shaka.net.HttpNdnPlugin,
      shaka.net.NetworkingEngine.PluginPriority.PREFERRED);
}

window.onload = registerPlugin();
