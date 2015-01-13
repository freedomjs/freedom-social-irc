/*jslint white:true,sloppy:true, node:true */
/*global window:true,freedom:true,setTimeout,console,global */

/**
 * Implementation of a Social provider for freedom.js that
 * interacts with users on an IRC Server
 **/
var irc_factory = require('irc-factory/lib/irc');

/**
 * The SocialProvider implements the freedom.js social API
 * It wraps an XMPP Client, and handles freedom-specific
 * interactions like authentication.
 * @class XMPPSocialProvider
 * @constructor
 */
var IRCSocialProvider = function(dispatchEvent) {
  this.dispatchEvent = dispatchEvent;
  var social = freedom.social();
  this.STATUS = social.STATUS;
  this.ERRCODE = social.ERRCODE;

  this.client = null;
  this.credentials = null;
  this.loginOpts = null;
  this.buddies = {};

  // Logger
  this.logger = function() {};
  if (typeof freedom !== 'undefined' &&
      typeof freedom.core === 'function') {
    freedom.core().getLogger('[IRCSocialProvider]').then(function(log) { 
      this.logger = log;
    }.bind(this));
  } else if (typeof console !== 'undefined') {
    this.logger = console;
  }
};

/**
 * Begin the login view, potentially prompting for credentials.
 * This is expected to be overridden by a *-auth.js file
 * @override
 * @method login
 * @param {Object} loginOpts Setup information about the desired network.
 */
IRCSocialProvider.prototype.login = function(loginOpts, continuation) {
  if (loginOpts) {
    this.loginOpts = loginOpts;
  }

  if (!this.credentials) {
    if (this.view) {
      this.view.close();
    }
    this.view = freedom['core.view']();
    this.view.once('message', this.onCredentials.bind(this, continuation));
    this.view.on('message', this.view.close.bind(this.view));
    this.view.show('irc-login');
    return;
  }

  this.connect(continuation);
};

/**
 * Get credentials back from the view.
 * @method onCredentials
 * @private
 * @param {function} continuation call to complete the login promise.
 * @param {Object} msg The message sent from the authentication view.
 */
IRCSocialProvider.prototype.onCredentials = function(continuation, msg) {
  if (msg.cmd && msg.cmd === 'auth') {
    this.credentials = msg.message;
    this.login(null, continuation);
  } else if (msg.cmd && msg.cmd === 'error') {
    continuation(undefined, {
      errcode: 'LOGIN_FAILEDCONNECTION',
      message: this.ERRCODE.LOGIN_FAILEDCONNECTION
    });
  } else {
    continuation(undefined, {
      errcode: 'LOGIN_BADCREDENTIALS',
      message: this.ERRCODE.LOGIN_BADCREDENTIALS
    });
  }
};

/**
 * Create the IRC client, and begin connection to the server.
 * Uses settings from most recent 'login()' call, and
 * credentials retrieved from the view.
 * @method connect
 * @private
 * @param {Function} continuation Callback upon connection
 */
IRCSocialProvider.prototype.connect = function (continuation) {
  var connectOpts = {
    nick: this.credentials.userId,
    user: this.credentials.userId,
    server: this.credentials.host,
    hostname: 'localhost',
    realname: '-',
    port: this.credentials.port,
    secure: false
  };

  try {
    this.logger.warn(JSON.stringify(connectOpts));
    this.client = new irc_factory.Client('social', connectOpts);
  } catch(e) {
    this.logger.error(e.stack);
    continuation(undefined, {
      errcode: 'LOGIN_FAILEDCONNECTION',
      message: e.message
    });
    this.client = null;
    return;
  }
  irc_factory.Events.onAny(function (msg) {
    this.logger.warn(JSON.stringify(msg));
  }.bind(this));
  irc_factory.Events.on('social.registered', this.onOnline.bind(this, continuation));
  irc_factory.Events.on('social.names', this.updateRoster.bind(this));
  irc_factory.Events.on('social.privmsg', this.receiveMessage.bind(this));
};

/**
 * Clear any credentials / state in the app.
 * @method clearCachedCredentials
 */
IRCSocialProvider.prototype.clearCachedCredentials  = function(continuation) {
  delete this.credentials;
  continuation();
};

/**
 * Returns all the <client_state>s that we've seen so far (from any 'onClientState' event)
 * Note that buddies is dictionary keyed by IRC handle, with
 * keys sufficient to satisfy both the <user_profile> and the <client_state>
 * connections, since this provider can't distinguish multiple connections
 * by a single user.
 */
IRCSocialProvider.prototype.getClients = function(continuation) {
  continuation(this.buddies);
};

IRCSocialProvider.prototype.getUsers = function(continuation) {
  continuation(this.buddies);
};

/**
 * Sends a message to a user on the network.
 * If the destination is not specified or invalid, the mssage is dropped.
 * @method sendMessage
 * @param {String} to clientId of the device or user to send to.
 * @param {String} msg The message to send
 * @param {Function} continuation Callback after message is sent.
 */
IRCSocialProvider.prototype.sendMessage = function(to, msg, continuation) {
  if (!this.client) {
    this.logger.warn('No client available to send message to ' + to);
    continuation(undefined, {
      errcode: 'OFFLINE',
      message: this.ERRCODE.OFFLINE
    });
    return;
  }
  
  this.client.privmsg(to, JSON.stringify(msg));
  continuation();
};

/**
 * Receive a textual message from IRC and relay it to
 * the parent module.
 * @method receiveMessage
 * @private
 * @param {String} msg The messag,e sender, and time
 */
IRCSocialProvider.prototype.receiveMessage = function(msg) {
  var parsedMessage;

  if (msg.target === this.credentials.userId && msg.message) {
    try {
      parsedMessage = JSON.parse(msg.message);
    } catch (e) {
      this.logger.log('Got Malformed message from' + msg.nickname);
      return;
    }
    if (this.buddies.indexOf(msg.nickname) === -1) {
      this.logger.warn('Dropping message from unknown user ' + msg.nickname);
      return;
    }
    this.dispatchEvent('onMessage', {
      from: {
        userId: msg.nickname,
        clientId: msg.nickname,
        status: "ONLINE",
        lastUpdated: msg.time,
        lastSeen: msg.time
      },
      message: parsedMessage
    });
  }
};

IRCSocialProvider.prototype.updateRoster = function(msg) {
  var i;
  for (i = 0; i < msg.names.length; i += 1) {
    if (!this.buddies[msg.names[i]]) {
      this.buddies[msg.names[i]] = {
        userId: msg.names[i],
        name: msg.names[i],
        clientId: msg.names[i],
        status: 'ONLINE',
        lastUpdated: msg.time,
        lastSeen: msg.time
      };
      this.dispatchEvent('onClientState', this.buddies[msg.names[i]]);
    }
  }
  this.logger.log('Channel List Received');
};

IRCSocialProvider.prototype.onOnline = function(continuation, ircInfo) {
  // Join Channel.
  this.client.join(this.credentials.room ||
                   '#freedom-' + (this.loginOpts.agent || 'social'));

  this.status = 'ONLINE';  
  this.buddies = {};
  this.buddies[ircInfo.nickname] = {
    userId: ircInfo.nickname,
    name: ircInfo.realname || ircInfo.username || ircInfo.nickname,
    clientId: ircInfo.nickname,
    status: this.status,
    lastUpdated: ircInfo.time,
    lastSeen: ircInfo.time
  };
  
  // Update status.
  continuation(this.buddies[ircInfo.nickname]);
};

IRCSocialProvider.prototype.logout = function(continuation) {
  this.status = 'OFFLINE';
  this.buddies = {};
  this.credentials = null;
  if (this.client) {
    this.client.disconnect();
    this.client = null;
  }
  continuation();
};

// Register provider when in a module context.
if (typeof freedom !== 'undefined') {
  freedom.social().provideAsynchronous(IRCSocialProvider);
}