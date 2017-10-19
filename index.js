/**
 * Main application entry point.
 */

'use strict';

const DeviceClient = require('./lib/device.client'),
    Subscription   = require('./lib/subscriber'),
    util           = require('util'),
    debug          = require('debug')('upnp-mediarenderer-client'),
    et             = require('elementtree'),
    MEDIA_EVENTS   = [
        'status',
        'loading',
        'playing',
        'paused',
        'stopped',
        'speedChanged'
    ];


/**
 * Do nothing.
 *
 * @return {void}
 */
const noop = () => {};


/**
 *
 * @param {string} url XML config address
 *
 * @constructor
 */
function MediaRendererClient ( url ) {
    if ( !/\.xml$/.test(url) && url[url.length - 1] !== '/' ) {
        url += '/';
    }

    DeviceClient.call(this, url);
    this.instanceId = 0;
    this.subscriptions = {};

    // Subscribe / unsubscribe from AVTransport depending
    // on relevant registered / removed event listeners.
    let self = this;
    let refs = 0;
    let receivedState;

    this.addListener('newListener', function ( eventName, listener ) {
        if ( MEDIA_EVENTS.indexOf(eventName) === -1 ) {
            return;
        }

        if ( refs === 0 ) {
            receivedState = false;
            self.subscribe('AVTransport', onstatus);
        }
        refs++;
    });

    this.addListener('removeListener', function ( eventName, listener ) {
        if ( MEDIA_EVENTS.indexOf(eventName) === -1 ) {
            return;
        }

        refs--;

        if ( refs === 0 ) {
            self.unsubscribe('AVTransport', onstatus);
        }
    });

    function onstatus ( e ) {
        self.emit('status', e);

        if ( !receivedState ) {
            // Starting from here we only want state updates.
            // As the first received event is the full service state, we ignore it.
            receivedState = true;
            return;
        }

        if ( e.hasOwnProperty('TransportState') ) {
            switch(e.TransportState) {
                case 'TRANSITIONING':
                    self.emit('loading');
                    break;
                case 'PLAYING':
                    self.emit('playing');
                    break;
                case 'PAUSED_PLAYBACK':
                    self.emit('paused');
                    break;
                case 'STOPPED':
                    self.emit('stopped');
                    break;
            }
        }

        if ( e.hasOwnProperty('TransportPlaySpeed') ) {
            self.emit('speedChanged', Number(e.TransportPlaySpeed));
        }
    }

}

util.inherits(MediaRendererClient, DeviceClient);


/**
 * Create subscription.
 *
 * @param {string} serviceId
 * @param {function} callback
 */
MediaRendererClient.prototype.subscribe = function ( serviceId, callback ) {
    const self = this;

    if ( this.subscriptions[serviceId] ) {
        return;
    }

    const url = this.url.replace(/https?:\/\//, '').replace(/:.+$/, ''),
        port  = this.url.replace(/^.+:/, '').replace(/\D.*$/, '');

    this.getDeviceDescription(( error, result ) => {
        if ( result ) {
            let eventSubURL;

            if ( result.services['urn:upnp-org:serviceId:' + serviceId] ) {
                eventSubURL = result.services['urn:upnp-org:serviceId:' + serviceId].eventSubURL;
            }

            if ( eventSubURL ) {
                self.subscriptions[serviceId] = new Subscription(
                    url,
                    port,
                    result.services['urn:upnp-org:serviceId:' + serviceId].eventSubURL
                ).on('message', callback);
            } else {
                callback('Subscription to ' + serviceId + ' failed!');
            }
        }
    });
};


/**
 * Unsubscribe from an existing subscription.
 *
 * @param {string} serviceId service name
 */
MediaRendererClient.prototype.unsubscribe = function ( serviceId ) {
    this.subscriptions[serviceId].unsubscribe();
    delete this.subscriptions[serviceId];
};


/**
 * Set public name for control point.
 *
 * @param {string} name public name for control point
 */
MediaRendererClient.prototype.setControlPointName = function ( name ) {
    this.controlPointName = name;
};


/**
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.getSupportedProtocols = function ( callback ) {
    this.callAction('ConnectionManager', 'GetProtocolInfo', {}, function ( err, result ) {
        if ( err ) {
            return callback(err);
        }

        // Here we leave off the `Source` field as we're hopefuly dealing with a Sink-only device.
        let lines = result.Sink.split(',');

        let protocols = lines.map(line => {
            let tmp = line.split(':');

            return {
                protocol: tmp[0],
                network: tmp[1],
                contentFormat: tmp[2],
                additionalInfo: tmp[3]
            };
        });

        callback(null, protocols);
    });
};


/**
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.getPosition = function ( callback ) {
    this.callAction('AVTransport', 'GetPositionInfo', {InstanceID: this.instanceId}, function ( error, result ) {
        callback = callback || noop;

        if ( error ) {
            return callback(err);
        }

        let str = result.AbsTime !== 'NOT_IMPLEMENTED' ? result.AbsTime : result.RelTime;

        callback(null, parseTime(str));
    });
};


/**
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.getDuration = function ( callback ) {
    this.callAction('AVTransport', 'GetMediaInfo', {InstanceID: this.instanceId}, function ( err, result ) {
        if ( err ) {
            return callback(err);
        }

        callback(null, parseTime(result.MediaDuration));
    });
};


/**
 *
 * @param {string} url
 * @param {Object} options
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.setUri = function ( url, options, callback ) {
    let self = this;

    if ( typeof options === 'function' ) {
        callback = options;
        options = {};
    }

    let contentType = options.contentType || 'video/mpeg'; // Default to something generic
    let protocolInfo = 'http-get:*:' + contentType + ':*';

    let metadata = options.metadata || {};
    metadata.url = url;
    metadata.protocolInfo = protocolInfo;

    let params = {
        RemoteProtocolInfo: protocolInfo,
        PeerConnectionManager: null,
        PeerConnectionID: -1,
        Direction: 'Input'
    };

    this.callAction('ConnectionManager', 'PrepareForConnection', params, function ( err, result ) {
        if ( err ) {
            if ( err.code !== 'ENOACTION' ) {
                return callback(err);
            }

            // If PrepareForConnection is not implemented, we keep the default (0) InstanceID
        } else {
            self.instanceId = result.AVTransportID;
        }

        let params = {
            InstanceID: self.instanceId,
            CurrentURI: url,
            CurrentURIMetaData: buildMetadata(metadata)
        };

        self.callAction('AVTransport', 'SetAVTransportURI', params, function ( err ) {
            if ( err ) {
                return callback(err);
            }

            if ( options.autoplay ) {
                self.play(callback);
                return;
            }
            callback();
        });
    });
};


/**
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.play = function ( callback ) {
    let params = {
        InstanceID: this.instanceId,
        Speed: 1,
    };

    this.callAction('AVTransport', 'Play', params, callback || noop);
};


/**
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.pause = function ( callback ) {
    let params = {
        InstanceID: this.instanceId
    };

    this.callAction('AVTransport', 'Pause', params, callback || noop);
};


/**
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.stop = function ( callback ) {
    let params = {
        InstanceID: this.instanceId
    };

    this.callAction('AVTransport', 'Stop', params, callback || noop);
};


/**
 *
 * @param {number} seconds
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.seek = function ( seconds, callback ) {
    let params = {
        InstanceID: this.instanceId,
        Unit: 'REL_TIME',
        Target: !isNaN(seconds) && isFinite(seconds) && seconds > 0 ? formatTime(seconds) : formatTime(0)
    };

    this.callAction('AVTransport', 'Seek', params, callback || noop);
};


/**
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.getVolume = function ( callback ) {
    this.callAction('RenderingControl', 'GetVolume', {InstanceID: this.instanceId, Channel: 'Master'}, function ( err, result ) {
        if ( err ) {
            return callback(err);
        }

        callback(null, parseInt(result.CurrentVolume));
    });
};


/**
 * Set volume on renderer.
 *
 * @param {number} volume
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.setVolume = function ( volume, callback ) {
    let params = {
        InstanceID: this.instanceId,
        Channel: 'Master',
        DesiredVolume: volume
    };

    this.getVolume.volumeLevel = 'volumeLevel' in this.getVolume ? this.getVolume.volumeLevel : volume;

    this.callAction('RenderingControl', 'SetVolume', params, callback || noop);
};


/**
 *
 * @param {Object} state
 * @param {boolean} state.mute
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.setMute = function ( state, callback ) {
    let params = {
        InstanceID: this.instanceId,
        Channel: 'Master',
        DesiredMute: state.mute
    };

    this.callAction('RenderingControl', 'SetMute', params, callback || noop);
};


/**
 * This action returns information associated with the current media of the specified instance; it has no effect on state.
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.getMediaInfo = function ( callback ) {
    this.callAction('AVTransport', 'GetMediaInfo', {InstanceID: this.instanceId}, function ( err, result ) {
        if ( err ) {
            return callback(err);
        }

        callback(null, result);
    });
};


/**
 * This action returns information associated with the current position of the transport of the specified instance; it has no effect on state.
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.getPositionInfo = function ( callback ) {
    this.callAction('AVTransport', 'GetPositionInfo', {InstanceID: this.instanceId}, function ( err, result ) {
        if ( err ) {
            return callback(err);
        }

        callback(null, result);
    });
};


/**
 * This action returns information associated with the current transport state of the specified instance; it has no effect on state.
 *
 * @param {function} callback method to invoke with a result of operation
 */
MediaRendererClient.prototype.getTransportInfo = function ( callback ) {
    this.callAction('AVTransport', 'GetTransportInfo', {InstanceID: this.instanceId}, function ( err, result ) {
        if ( err ) {
            return callback(err);
        }

        callback(null, result);
    });
};


/**
 *
 * @param {number} seconds
 *
 * @return {string}
 */
function formatTime ( seconds ) {
    let h = 0;
    let m = 0;
    let s = 0;

    h = Math.floor((seconds - (h * 0)    - (m * 0 )) / 3600);
    m = Math.floor((seconds - (h * 3600) - (m * 0 )) / 60);
    s =            (seconds - (h * 3600) - (m * 60));

    function pad ( v ) {
        return (v < 10) ? '0' + v : v;
    }

    return [pad(h), pad(m), pad(s)].join(':');
}


/**
 *
 * @param time
 *
 * @return {*}
 */
function parseTime ( time ) {
    let parts = time.split(':').map(Number);

    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}


/**
 *
 * @param metadata
 */
function buildMetadata ( metadata ) {
    let didl = et.Element('DIDL-Lite');

    didl.set('xmlns', 'urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/');
    didl.set('xmlns:dc', 'http://purl.org/dc/elements/1.1/');
    didl.set('xmlns:upnp', 'urn:schemas-upnp-org:metadata-1-0/upnp/');
    didl.set('xmlns:sec', 'http://www.sec.co.kr/');

    let item = et.SubElement(didl, 'item');

    item.set('id', 0);
    item.set('parentID', -1);
    item.set('restricted', false);

    let OBJECT_CLASSES = {
        'audio': 'object.item.audioItem.musicTrack',
        'video': 'object.item.videoItem.movie',
        'image': 'object.item.imageItem.photo'
    };

    if ( metadata.type ) {
        let upnpClass = et.SubElement(item, 'upnp:class');

        upnpClass.text = OBJECT_CLASSES[metadata.type];
    }

    if ( metadata.title ) {
        let title = et.SubElement(item, 'dc:title');

        title.text = metadata.title;
    }

    if ( metadata.creator ) {
        let creator = et.SubElement(item, 'dc:creator');

        creator.text = metadata.creator;
    }

    if ( metadata.url && metadata.protocolInfo ) {
        let res = et.SubElement(item, 'res');

        res.set('protocolInfo', metadata.protocolInfo);
        res.text = metadata.url;
    }

    if ( metadata.subtitlesUrl ) {
        let captionInfo = et.SubElement(item, 'sec:CaptionInfo');

        captionInfo.set('sec:type', 'srt');
        captionInfo.text = metadata.subtitlesUrl;

        let captionInfoEx = et.SubElement(item, 'sec:CaptionInfoEx');

        captionInfoEx.set('sec:type', 'srt');
        captionInfoEx.text = metadata.subtitlesUrl;

        // Create a second `res` for the subtitles
        let res = et.SubElement(item, 'res');

        res.set('protocolInfo', 'http-get:*:text/srt:*');
        res.text = metadata.subtitlesUrl;
    }

    let doc = new et.ElementTree(didl);

    return doc.write({ xml_declaration: false });
}


module.exports = MediaRendererClient;
