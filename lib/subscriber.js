/**
 *
 */

'use strict';

const http            = require('http'),
    ip                = require('ip'),
    util              = require('util'),
    events            = require('events'),
    xmlResponseParser = require('parsexmlresponse');

let httpServerEmitter  = new events(),
    httpServerStarting = false,
    httpServerStarted  = false,
    subscriptions      = new Map(),
    httpServerPort,
    httpSubscriptionResponseServer;

httpServerEmitter.setMaxListeners(100);


/**
 * Parse valuable data from renderer to readable structure.
 *
 * @param {Object} data data to parse
 *
 * @return {Object|null} parsed data
 */
function parseSubscriptionData ( data ) {
    const actualData  = data['e:propertyset']['e:property']['LastChange'],
        removeWrapper = /^[\S\s]*<InstanceID val="\d+"><([\S\s]*)\/><\/InstanceID>[\S\s]*$/,
        subscriptionDataToOutput = {};

    let parsed;

    if ( actualData && (parsed = actualData.match(removeWrapper)) ) {
        if ( /^(?:CurrentTrackMetaData|AVTransportURIMetaData)/.test(parsed[1]) ) {
            const fastXmlParser = require('fast-xml-parser'),
                options = {
                    attrPrefix: '',
                    textNodeName: '#text',
                    ignoreNonTextNodeAttr: false,
                    ignoreTextNodeAttr: false,
                    textNodeConversion: true,
                    textAttrConversion: true
                },
                jsonObj = fastXmlParser.parse('<' + parsed[1] + '/>', options);

            let aInfo = jsonObj.CurrentTrackMetaData.item,
                bInfo = jsonObj.AVTransportURIMetaData.item,
                aRes  = aInfo.res,
                bRes  = bInfo.res;

            delete aInfo.res;
            delete bInfo.res;

            return {
                CurrentTrackMetaData: Object.assign(aInfo, aRes),
                AVTransportURIMetaData: Object.assign(bInfo, bRes)
            };
        } else {
            parsed = parsed[1].split('/><').map(elem => {
                return elem.split(' ').map(( elem, idx ) => {
                    return idx ? elem.split('=') : elem;
                });
            });

            for ( let i = 0; i < parsed.length; i += 1 ) {
                for ( let j = 0; j < parsed[i].length; j += 1 ) {
                    if ( j ) {
                        if ( parsed[i][j].length === 2 ) {
                            let timeValue  = /^(?:\d+:)+\d+(?:\.\d+)?$/,
                                resolution = /\B\d+x\d+\B/,
                                //actionsValue = /^((?:[a-z]+,)+)?[a-z]+$/i,
                                key        = parsed[i][j][0],
                                value      = parsed[i][j][1] = parsed[i][j][1].replace(/"/g, ''),
                                tmp;

                            if ( timeValue.test(value) || resolution.test(value) ) {
                                subscriptionDataToOutput[parsed[i][0]][key] = value;
                            } else if ( parsed[i][0] === 'CurrentTransportActions' ) {
                                subscriptionDataToOutput[parsed[i][0]][key] = value.split(',');
                            } else{
                                subscriptionDataToOutput[parsed[i][0]][key] = isNaN(tmp = parseInt(value, 10)) ? value : tmp;
                            }
                        } else {
                            subscriptionDataToOutput[parsed[i][0]][parsed[i][j][0]] = null;
                        }
                    } else {
                        subscriptionDataToOutput[parsed[i][j]] = {};
                    }
                }
            }
        }

        return subscriptionDataToOutput;
    } else {
        return null; // unusable/non-informative data
    }
}


let ensureHttpServer = function ( callback ) {
    if ( httpServerStarting ) {
        httpServerEmitter.once('started', callback);
    } else {
        httpServerStarting = true;

        httpSubscriptionResponseServer = http.createServer();
        httpServerPort = 0; // do the trick
        httpSubscriptionResponseServer.listen(httpServerPort, () => {
            httpServerPort = httpSubscriptionResponseServer.address().port;

            httpServerStarted = true;
            httpServerEmitter.emit('started');
            httpServerStarting = false;
            httpSubscriptionResponseServer.on('request', ( req, res ) => {
                let sid = req.headers.sid,
                    handle = xmlResponseParser((err, data) => {
                        let emitter = subscriptions.get(sid);

                        if ( emitter ) {
                            let ret = parseSubscriptionData(data);

                            if ( ret ) {
                                emitter.emit('message', {sid: sid, body: ret});
                            }
                        }
                    });

                handle(req, res);
            });

            callback();
        });
    }
};


/**
 * Create subscription instance.
 *
 * @param {string} host
 * @param {string} port
 * @param {string} eventSub
 * @param {number} requestedTimeoutSeconds
 *
 * @constructor
 */
function Subscription ( host, port, eventSub, requestedTimeoutSeconds ) {
    let sid,
        resubscribeTimeout,
        emitter = this,
        timeoutSeconds = requestedTimeoutSeconds || 1800;


    function resubscribe () {
        if ( sid ) {
            const req = http.request({
                host: host,
                port: port,
                path: eventSub,
                method: 'SUBSCRIBE',
                headers: {
                    'SID': sid,
                    'TIMEOUT': 'Second-' + timeoutSeconds
                }
            }, function ( res ) {
                emitter.emit('resubscribed', {sid: sid});
                resubscribeTimeout = setTimeout(resubscribe, (timeoutSeconds - 1) * 1000);
            }).on('error', function ( e ) {
                emitter.emit('error:resubscribe', {sid: sid, error: e});
            }).end();
        }
    }


    this.unsubscribe = function unsubscribe () {
        clearTimeout(resubscribeTimeout);
        if (sid) {
            http.request({
                host: host,
                port: port,
                path: eventSub,
                method: 'UNSUBSCRIBE',
                headers: {
                    'SID': sid
                }
            }, function(res) {
                emitter.emit('unsubscribed', { sid: sid });
            }).on('error', function(e) {
                emitter.emit('error:unsubscribe', e);
            }).setTimeout(3000, () => emitter.emit('unsubscribed', { sid: sid })).end();
        } else {
            emitter.emit('error:unsubscribe', new Error('No SID for subscription'));
        }
        subscriptions.delete(sid);
    }.bind(this);

    this.init = function () {
        http.request({
            host: host,
            port: port,
            path: eventSub,
            method: 'SUBSCRIBE',
            headers: {
                'CALLBACK': "<http://" + ip.address() + ':' + httpServerPort + ">",
                'NT': 'upnp:event',
                'TIMEOUT': 'Second-' + timeoutSeconds
            }
        }, function(res) {
            emitter.emit('subscribed', { sid: res.headers.sid });
            sid = res.headers.sid;
            if (res.headers.timeout) {
                let subscriptionTimeout = res.headers.timeout.match(/\d+/);
                if (subscriptionTimeout) {
                    timeoutSeconds = subscriptionTimeout[0];
                }
            }
            resubscribeTimeout = setTimeout(resubscribe, (timeoutSeconds-1) * 1000);
            subscriptions.set(sid, emitter);
        }).on('error', function(e) {
            emitter.emit('error', e);
            subscriptions.delete(sid);
        }).end();
        events.EventEmitter.call(this);
    }.bind(this);

    if ( !httpServerStarted ) {
        ensureHttpServer(this.init);
    } else {
        this.init();
    }
}


util.inherits(Subscription, events.EventEmitter);

module.exports = Subscription;
