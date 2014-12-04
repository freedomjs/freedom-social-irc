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
 * Create an XMPP.Client, and begin connection to the server.
 * Uses settings from most recent 'login()' call, and from
 * credentials retrieved from the view.
 * @method connect
 * @private
 * @param {Function} continuation Callback upon connection
 */
IRCSocialProvider.prototype.connect = function(continuation) {
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
    return;
  }
  irc_factory.Events.onAny(function (msg) {
    this.logger.warn(JSON.stringify(msg));
  }.bind(this));
  irc_factory.Events.on('social.registered', this.onOnline.bind(this, continuation));
  irc_factory.Events.on('social.who', this.updateRoster.bind(this));
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
 * Note: this instance's own <client_state> will be somewhere in this list
 * Use the clientId returned from social.login() to extract your element
 * 
 * @method getClients
 * @return {Object} { 
 *    'clientId1': <client_state>,
 *    'clientId2': <client_state>,
 *     ...
 * } List of <client_state>s indexed by clientId
 *   On failure, rejects with an error code (see above)
 */
IRCSocialProvider.prototype.getClients = function(continuation) {
  continuation(this.vCardStore.getClients());
};

IRCSocialProvider.prototype.getUsers = function(continuation) {
  continuation(this.vCardStore.getUsers());
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
 * Handle messages from the XMPP client.
 * @method onMessage
 * @private
 */
IRCSocialProvider.prototype.onMessage = function(msg) {
  // Is it a message?
  if (msg.is('message') && msg.getChildText('body') && msg.attrs.type !== 'error') {
    this.sawClient(msg.attrs.from);
    // TODO: check the agent matches our resource Id so we don't pick up chats not directed
    // at this client.
    this.receiveMessage(msg.attrs.from, msg.getChildText('body'));
    /*
    if (msg.attrs.to.indexOf(this.loginOpts.agent) !== -1) {
      this.receiveMessage(msg.attrs.from, msg.getChildText('body'));
    } else {
      // TODO: relay chat messages from other clients in some way.
      this.logger.warn('Ignoring Chat Message: ' + JSON.stringify(msg.attrs));
    }
    */
  // Is it a status request?
  } else if (msg.is('iq') && msg.attrs.type === 'get') {
    if (msg.getChild('query') && msg.getChild('query').attrs.xmlns ===
        'http://jabber.org/protocol/disco#info') {
      this.sawClient(msg.attrs.from);

      this.sendCapabilities(msg.attrs.from, msg);      
    }
  // Is it a staus response?
  } else if (msg.is('iq') && (msg.attrs.type === 'result' ||
      msg.attrs.type === 'set')) {
    this.updateRoster(msg);
  // Is it a status?
  } else if (msg.is('presence')) {
    this.onPresence(msg);
  // Is it something we don't understand?
  } else {
    this.logger.warn('Dropped unknown XMPP message');
    this.logger.warn(msg);
  }
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

  this.logger.log('Got Message!', msg);
  if (msg.target === this.credentials.userId) {
    try {
      parsedMessage = JSON.parse(msg);
    } catch (e) {
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
  this.logger.log('Got channel list', msg);
};

IRCSocialProvider.prototype.onOnline = function(continuation, ircInfo) {
  // Join Channel.
  this.client.join(this.credentials.room ||
                   '#freedom-' + (this.loginOpts.agent || 'social'));

  this.status = 'ONLINE';  
  
  // Update status.
  continuation({
    userId: ircInfo.nickname,
    clientId: ircInfo.nickname,
    status: this.status,
    timestamp: ircInfo.time
  });
};

IRCSocialProvider.prototype.logout = function(continuation) {
  var userId = this.credentials? this.credentials.userId : null;

  this.status = 'OFFLINE';
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