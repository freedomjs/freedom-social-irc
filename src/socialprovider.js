/*jslint white:true,sloppy:true */
/*global window:true,freedom:true,setTimeout,console,VCardStore,global */

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

  // If the destination client is ONLINE (i.e. using the same type of client)
  // send this message with type 'normal' so it only reaches that client,
  // otherwise use type 'chat' to send to all clients.
  // Sending all messages as type 'normal' means we can't communicate across
  // different client types, but sending all as type 'chat' means messages
  // will be broadcast to all clients.
  var messageType = (this.vCardStore.getClient(to).status === 'ONLINE') ?
      'normal' : 'chat';
  
  try {
    // After each message is received, reset the timeout to
    // wait for at least 100ms to batch other messages received 
    // in that window. However, if the oldest message in the batch 
    // was received over 2s ago, don't reset the timeout, and 
    // just allow the current timeout to execute.
    this.messages.push(msg);
    if (!this.sendMessagesTimeout) {
      this.timeOfFirstMessageInBatch = Date.now();
    }
    if ((Date.now() - this.timeOfFirstMessageInBatch < 2000) ||
        !this.sendMessagesTimeout) {
      clearTimeout(this.sendMessagesTimeout);
      this.sendMessagesTimeout = setTimeout(function() {
        this.client.send(new window.XMPP.Element('message', {
          to: to,
          type: messageType
        }).c('body').t(JSON.stringify(this.messages)));
        this.messages = [];
        this.sendMessagesTimeout = null;
      }.bind(this), 100);  
    }
  } catch(e) {
    this.logger.error(e.stack);
    continuation(undefined, {
      errcode: 'UNKNOWN',
      message: e.message
    });
    return;
  }
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
 * Receive a textual message from XMPP and relay it to
 * the parent module.
 * @method receiveMessage
 * @private
 * @param {String} from The Client ID of the message origin
 * @param {String} msgs A batch of messages.
 */
IRCSocialProvider.prototype.receiveMessage = function(from, msgs) {
  var i, parsedMessages = JSON.parse(msgs);
  for (i = 0; i < parsedMessages.length; i+=1) {
    this.dispatchEvent('onMessage', {
      from: this.vCardStore.getClient(from),
      to: this.vCardStore.getClient(this.id),
      message: parsedMessages[i]
    });
  }
};

/**
 * Reply to a capability inquiry with client abilities.
 * @method sendCapabilities
 * @private
 * @param {String} to The client requesting capabilities
 * @param {XMPP.Stanza} msg The request message
 */
IRCSocialProvider.prototype.sendCapabilities = function(to, msg) {
  var query = msg.getChild('query');
  
  msg.attrs.to = msg.attrs.from;
  delete msg.attrs.from;
  msg.attrs.type = 'result';

  query.c('identity', {
    category: 'client',
    name: this.loginOpts.agent,
    type: 'bot'
  }).up()
  .c('feature', {'var': 'http://jabber.org/protocol/caps'}).up()
  .c('feature', {'var': 'http://jabber.org/protocol/disco#info'}).up()
  .c('feature', {'var': this.loginOpts.url}).up();
  this.client.send(msg);
};

/**
 * Receive an XMPP Presence change message from another user.
 * @method onPresence
 * @private
 * @param {XMPP.Stanza} msg The incoming message
 */
IRCSocialProvider.prototype.onPresence = function(msg) {
  var status = msg.getChildText('show') || 'online',
      user = msg.attrs.from,
      hash;
  if (msg.attrs.type === 'unavailable') {
    status = 'unavailable';
  }

  if (msg.getChild('x') && msg.getChild('x').getChildText('photo')) {
    hash = msg.getChild('x').getChildText('photo');
  }
  
  if (status === 'unavailable') {
    this.vCardStore.updateProperty(user, 'status', 'OFFLINE');
  } else {
    if (msg.getChild('c') && msg.getChild('c').attrs.node === this.loginOpts.url) {
      this.vCardStore.updateProperty(user, 'status', 'ONLINE');
    } else {
      this.vCardStore.updateProperty(user, 'status', 'ONLINE_WITH_OTHER_APP');
    }
  }
  
  this.vCardStore.updateProperty(user, 'xmppStatus', status);

  this.vCardStore.refreshContact(user, hash);
};

IRCSocialProvider.prototype.updateRoster = function(msg) {
  var from = msg.attrs.from || msg.attrs.to,
      query = msg.getChild('query'),
      vCard = msg.getChild('vCard'),
      items, i;

  // Response to Query
  if (query && query.attrs.xmlns === 'jabber:iq:roster') {
    items = query.getChildren('item');
    for (i = 0; i < items.length; i += 1) {
      if(items[i].attrs.jid && items[i].attrs.name) {
        this.vCardStore.updateUser(items[i].attrs.jid, 'name',
            items[i].attrs.name);
        this.vCardStore.refreshContact(items[i].attrs.jid);
      }
    }
  }

  // Response to photo
  if (vCard && vCard.attrs.xmlns === 'vcard-temp') {
    this.vCardStore.updateVcard(from, vCard);
  }
};

IRCSocialProvider.prototype.sawClient = function(client) {
  this.vCardStore.updateProperty(client, 'timestamp', new Date());
};

IRCSocialProvider.prototype.onOnline = function(continuation) {
  // Announce.
  this.client.send(new window.XMPP.Element('presence', {})
      .c('show').t('xa').up() // Mark status 'extended away'
      .c('c', { // Advertise capabilities
        xmlns: 'http://jabber.org/protocol/caps',
        node: this.loginOpts.url,
        ver: this.loginOpts.version,
        hash: 'fixed'
      }).up());

  this.status = 'ONLINE';  
  // Get roster.
  this.client.send(new window.XMPP.Element('iq', {type: 'get'})
      .c('query', {
        xmlns: 'jabber:iq:roster'
      }).up());
  
  // Update status.
  this.vCardStore.updateProperty(this.id, 'status', 'ONLINE');
  this.vCardStore.refreshContact(this.id, null);
  
  continuation(this.vCardStore.getClient(this.id));
};

IRCSocialProvider.prototype.logout = function(continuation) {
  var userId = this.credentials? this.credentials.userId : null;

  this.status = 'offline';
  this.credentials = null;
  if (this.client) {
    this.client.send(new window.XMPP.Element('presence', {
      type: 'unavailable'
    }));
    this.client.end();
    this.client = null;
  }
  continuation();
};

IRCSocialProvider.prototype.requestUserStatus = function(user) {
  if (!this.client) {
    this.logger.warn('User status request to ' + user + ' dropped, no client available.');
    return;
  }
  this.client.send(new window.XMPP.Element('iq', {
    type: 'get',
    to: user
  }).c('vCard', {'xmlns': 'vcard-temp'}).up());
};

IRCSocialProvider.prototype.onUserChange = function(card) {
  this.dispatchEvent('onUserProfile', card);
};

IRCSocialProvider.prototype.onClientChange = function(card) {
  this.dispatchEvent('onClientState', card);
};

// Register provider when in a module context.
if (typeof freedom !== 'undefined') {
  freedom.social().provideAsynchronous(IRCSocialProvider);
}