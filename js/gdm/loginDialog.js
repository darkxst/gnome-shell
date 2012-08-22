// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/*
 * Copyright 2011 Red Hat, Inc
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA
 * 02111-1307, USA.
 */

const AccountsService = imports.gi.AccountsService;
const Clutter = imports.gi.Clutter;
const CtrlAltTab = imports.ui.ctrlAltTab;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Mainloop = imports.mainloop;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const Signals = imports.signals;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Gdm = imports.gi.Gdm;

const Batch = imports.gdm.batch;
const Fprint = imports.gdm.fingerprint;
const GdmUtil = imports.gdm.util;
const Lightbox = imports.ui.lightbox;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const Tweener = imports.ui.tweener;

const _RESIZE_ANIMATION_TIME = 0.25;
const _SCROLL_ANIMATION_TIME = 0.5;
const _TIMED_LOGIN_IDLE_THRESHOLD = 5.0;
const _LOGO_ICON_NAME_SIZE = 48;

let _loginDialog = null;

function _smoothlyResizeActor(actor, width, height) {
    let finalWidth;
    let finalHeight;

    if (width < 0)
        finalWidth = actor.width;
    else
        finalWidth = width;

    if (height < 0)
        finalHeight = actor.height;
    else
        finalHeight = height;

    actor.set_size(actor.width, actor.height);

    if (actor.width == finalWidth && actor.height == finalHeight)
        return null;

    let hold = new Batch.Hold();

    Tweener.addTween(actor,
                     { width: finalWidth,
                       height: finalHeight,
                       time: _RESIZE_ANIMATION_TIME,
                       transition: 'easeOutQuad',
                       onComplete: Lang.bind(this, function() {
                                       hold.release();
                                   })
                     });
    return hold;
}

const UserListItem = new Lang.Class({
    Name: 'UserListItem',

    _init: function(user) {
        this.user = user;
        this._userChangedId = this.user.connect('changed',
                                                 Lang.bind(this, this._onUserChanged));

        let layout = new St.BoxLayout({ vertical: false });
        this.actor = new St.Button({ style_class: 'login-dialog-user-list-item',
                                     can_focus: true,
                                     child: layout,
                                     reactive: true,
                                     x_align: St.Align.START,
                                     x_fill: true });

        this._iconBin = new St.Bin();
        layout.add(this._iconBin);
        let textLayout = new St.BoxLayout({ style_class: 'login-dialog-user-list-item-text-box',
                                            vertical:    true });
        layout.add(textLayout, { expand: true });

        this._nameLabel = new St.Label({ text:        this.user.get_real_name(),
                                         style_class: 'login-dialog-user-list-item-name' });
        textLayout.add(this._nameLabel,
                       { y_fill: false,
                         y_align: St.Align.MIDDLE,
                         expand: true });

        this._timedLoginIndicator = new St.Bin({ style_class: 'login-dialog-timed-login-indicator',
                                                 scale_x: 0 });
        textLayout.add(this._timedLoginIndicator,
                       { x_fill: true,
                         x_align: St.Align.MIDDLE,
                         y_fill: false,
                         y_align: St.Align.END });

        this._updateIcon();
        this._updateLoggedIn();

        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
    },

    _onUserChanged: function() {
        this._nameLabel.set_text(this.user.get_real_name());
        this._updateIcon();
        this._updateLoggedIn();
    },

    _setIconFromFile: function(iconFile, styleClass) {
        if (styleClass)
            this._iconBin.set_style_class_name(styleClass);
        this._iconBin.set_style(null);

        this._iconBin.child = null;
        if (iconFile) {
            this._iconBin.show();
            // We use background-image instead of, say, St.TextureCache
            // so the theme writers can add a rounded frame around the image
            // and so theme writers can pick the icon size.
            this._iconBin.set_style('background-image: url("' + iconFile + '");' +
                                    'background-size: contain;');
        } else {
            this._iconBin.hide();
        }
    },

    _setIconFromName: function(iconName, styleClass) {
        if (styleClass)
            this._iconBin.set_style_class_name(styleClass);
        this._iconBin.set_style(null);

        if (iconName != null) {
            let icon = new St.Icon();
            icon.set_icon_name(iconName)

            this._iconBin.child = icon;
            this._iconBin.show();
        } else {
            this._iconBin.child = null;
            this._iconBin.hide();
        }
    },

    _updateIcon: function() {
        let iconFileName = this.user.get_icon_file();
        let gicon = null;

        if (GLib.file_test(iconFileName, GLib.FileTest.EXISTS))
            this._setIconFromFile(iconFileName, 'login-dialog-user-list-item-icon');
        else
            this._setIconFromName('avatar-default', 'login-dialog-user-list-item-icon');
    },

    syncStyleClasses: function() {
        this._updateLoggedIn();

        if (global.stage.get_key_focus() == this.actor)
            this.actor.add_style_pseudo_class('focus');
        else
            this.actor.remove_style_pseudo_class('focus');
    },

    _updateLoggedIn: function() {
        if (this.user.is_logged_in())
            this.actor.add_style_pseudo_class('logged-in');
        else
            this.actor.remove_style_pseudo_class('logged-in');
    },

    _onClicked: function() {
        this.emit('activate');
    },

    fadeOutName: function() {
        return GdmUtil.fadeOutActor(this._nameLabel);
    },

    fadeInName: function() {
        return GdmUtil.fadeInActor(this._nameLabel);
    },

    showTimedLoginIndicator: function(time) {
        let hold = new Batch.Hold();

        this.hideTimedLoginIndicator();
        Tweener.addTween(this._timedLoginIndicator,
                         { scale_x: 1.,
                           time: time,
                           transition: 'linear',
                           onComplete: function() {
                               hold.release();
                           },
                           onCompleteScope: this
                         });
        return hold;
    },

    hideTimedLoginIndicator: function() {
        Tweener.removeTweens(this._timedLoginIndicator);
        this._timedLoginIndicator.scale_x = 0.;
    }
});
Signals.addSignalMethods(UserListItem.prototype);

const UserList = new Lang.Class({
    Name: 'UserList',

    _init: function() {
        this.actor = new St.ScrollView({ style_class: 'login-dialog-user-list-view'});
        this.actor.set_policy(Gtk.PolicyType.NEVER,
                              Gtk.PolicyType.AUTOMATIC);

        this._box = new St.BoxLayout({ vertical: true,
                                       style_class: 'login-dialog-user-list',
                                       pseudo_class: 'expanded' });

        this.actor.add_actor(this._box);
        this._items = {};

        this.actor.connect('key-focus-in', Lang.bind(this, this._moveFocusToItems));
    },

    _moveFocusToItems: function() {
        let hasItems = Object.keys(this._items).length > 0;

        if (!hasItems)
            return;

        if (global.stage.get_key_focus() != this.actor)
            return;

        this.actor.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false);
    },

    _showItem: function(item) {
        let tasks = [function() {
                         return GdmUtil.fadeInActor(item.actor);
                     },

                     function() {
                         return item.fadeInName();
                     }];

        let batch = new Batch.ConsecutiveBatch(this, tasks);
        return batch.run();
    },

    _onItemActivated: function(activatedItem) {
        this.emit('activate', activatedItem);
    },

    giveUpWhitespace: function() {
        let container = this.actor.get_parent();

        container.child_set(this.actor, { expand: false });
    },

    takeOverWhitespace: function() {
        let container = this.actor.get_parent();

        container.child_set(this.actor, { expand: true });
    },

    pinInPlace: function() {
        this._box.set_size(this._box.width, this._box.height);
    },

    shrinkToNaturalHeight: function() {
        let oldWidth = this._box.width;
        let oldHeight = this._box.height;
        this._box.set_size(-1, -1);
        let [minHeight, naturalHeight] = this._box.get_preferred_height(-1);
        this._box.set_size(oldWidth, oldHeight);

        let batch = new Batch.ConsecutiveBatch(this,
                                               [function() {
                                                    return _smoothlyResizeActor(this._box, -1, naturalHeight);
                                                },

                                                function() {
                                                    this._box.set_size(-1, -1);
                                                }
                                               ]);

        return batch.run();
    },

    hideItemsExcept: function(exception) {
        let tasks = [];

        for (let userName in this._items) {
            let item = this._items[userName];

            item.actor.set_hover(false);
            item.actor.reactive = false;
            item.actor.can_focus = false;
            item.syncStyleClasses();
            item._timedLoginIndicator.scale_x = 0.;
            if (item != exception)
                tasks.push(function() {
                    return GdmUtil.fadeOutActor(item.actor);
                });
        }

        this._box.remove_style_pseudo_class('expanded');
        let batch = new Batch.ConsecutiveBatch(this,
                                               [function() {
                                                    return GdmUtil.fadeOutActor(this.actor.vscroll);
                                                },

                                                new Batch.ConcurrentBatch(this, tasks)
                                               ]);

        return batch.run();
    },

    hideItems: function() {
        return this.hideItemsExcept(null);
    },

    _getExpandedHeight: function() {
        let hiddenActors = [];
        for (let userName in this._items) {
            let item = this._items[userName];
            if (!item.actor.visible) {
                item.actor.show();
                hiddenActors.push(item.actor);
            }
        }

        if (!this._box.visible) {
            this._box.show();
            hiddenActors.push(this._box);
        }

        this._box.set_size(-1, -1);
        let [minHeight, naturalHeight] = this._box.get_preferred_height(-1);

        for (let i = 0; i < hiddenActors.length; i++) {
            let actor = hiddenActors[i];
            actor.hide();
        }

        return naturalHeight;
    },

    showItems: function() {
        let tasks = [];

        for (let userName in this._items) {
            let item = this._items[userName];
            item.actor.sync_hover();
            item.actor.reactive = true;
            item.actor.can_focus = true;
            item.syncStyleClasses();
            tasks.push(function() {
                return this._showItem(item);
            });
        }

        this._box.add_style_pseudo_class('expanded');
        let batch = new Batch.ConsecutiveBatch(this,
                                               [function() {
                                                    this.takeOverWhitespace();
                                                },

                                                function() {
                                                    let fullHeight = this._getExpandedHeight();
                                                    return _smoothlyResizeActor(this._box, -1, fullHeight);
                                                },

                                                new Batch.ConcurrentBatch(this, tasks),

                                                function() {
                                                    this.actor.set_size(-1, -1);
                                                },

                                                function() {
                                                    return GdmUtil.fadeInActor(this.actor.vscroll);
                                                }]);
        return batch.run();
    },

    scrollToItem: function(item) {
        let box = item.actor.get_allocation_box();

        let adjustment = this.actor.get_vscroll_bar().get_adjustment();

        let value = (box.y1 + adjustment.step_increment / 2.0) - (adjustment.page_size / 2.0);
        Tweener.removeTweens(adjustment);
        Tweener.addTween (adjustment,
                          { value: value,
                            time: _SCROLL_ANIMATION_TIME,
                            transition: 'easeOutQuad' });
    },

    jumpToItem: function(item) {
        let box = item.actor.get_allocation_box();

        let adjustment = this.actor.get_vscroll_bar().get_adjustment();

        let value = (box.y1 + adjustment.step_increment / 2.0) - (adjustment.page_size / 2.0);

        adjustment.set_value(value);
    },

    getItemFromUserName: function(userName) {
        let item = this._items[userName];

        if (!item)
            return null;

        return item;
    },

    addUser: function(user) {
        if (!user.is_loaded)
            return;

        if (user.is_system_account())
            return;

        if (user.locked)
           return;

        let userName = user.get_user_name();

        if (!userName)
            return;

        this.removeUser(user);

        let item = new UserListItem(user);
        this._box.add(item.actor, { x_fill: true });

        this._items[userName] = item;

        item.connect('activate',
                     Lang.bind(this, this._onItemActivated));

        // Try to keep the focused item front-and-center
        item.actor.connect('key-focus-in',
                           Lang.bind(this,
                                     function() {
                                         this.scrollToItem(item);
                                     }));

        this._moveFocusToItems();

        this.emit('item-added', item);
    },

    removeUser: function(user) {
        if (!user.is_loaded)
            return;

        let userName = user.get_user_name();

        if (!userName)
            return;

        let item = this._items[userName];

        if (!item)
            return;

        item.actor.destroy();
        delete this._items[userName];
    }
});
Signals.addSignalMethods(UserList.prototype);

const SessionListItem = new Lang.Class({
    Name: 'SessionListItem',

    _init: function(id, name) {
        this.id = id;

        this.actor = new St.Button({ style_class: 'login-dialog-session-list-item',
                                     can_focus: true,
                                     reactive: true,
                                     x_fill: true,
                                     x_align: St.Align.START });

        this._box = new St.BoxLayout({ style_class: 'login-dialog-session-list-item-box' });

        this.actor.add_actor(this._box);
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));

        this._dot = new St.DrawingArea({ style_class: 'login-dialog-session-list-item-dot' });
        this._dot.connect('repaint', Lang.bind(this, this._onRepaintDot));
        this._box.add_actor(this._dot);
        this.setShowDot(false);

        let label = new St.Label({ style_class: 'login-dialog-session-list-item-label',
                                   text: name });

        this._box.add_actor(label);
    },

    setShowDot: function(show) {
        if (show)
            this._dot.opacity = 255;
        else
            this._dot.opacity = 0;
    },

    _onRepaintDot: function(area) {
        let cr = area.get_context();
        let [width, height] = area.get_surface_size();
        let color = area.get_theme_node().get_foreground_color();

        cr.setSourceRGBA (color.red / 255,
                          color.green / 255,
                          color.blue / 255,
                          color.alpha / 255);
        cr.arc(width / 2, height / 2, width / 3, 0, 2 * Math.PI);
        cr.fill();
    },

    _onClicked: function() {
        this.emit('activate');
    }
});
Signals.addSignalMethods(SessionListItem.prototype);

const SessionList = new Lang.Class({
    Name: 'SessionList',

    _init: function() {
        this.actor = new St.Bin();

        this._box = new St.BoxLayout({ style_class: 'login-dialog-session-list',
                                       vertical: true});
        this.actor.child = this._box;

        this._button = new St.Button({ style_class: 'login-dialog-session-list-button',
                                       can_focus: true,
                                       x_fill: true,
                                       y_fill: true });
        let box = new St.BoxLayout();
        this._button.add_actor(box);

        this._triangle = new St.Label({ style_class: 'login-dialog-session-list-triangle',
                                        text: '\u25B8' });
        box.add_actor(this._triangle);

        let label = new St.Label({ style_class: 'login-dialog-session-list-label',
                                   text: _("Session...") });
        box.add_actor(label);

        this._button.connect('clicked',
                             Lang.bind(this, this._onClicked));
        this._box.add_actor(this._button);
        this._scrollView = new St.ScrollView({ style_class: 'login-dialog-session-list-scroll-view'});
        this._scrollView.set_policy(Gtk.PolicyType.NEVER,
                                    Gtk.PolicyType.AUTOMATIC);
        this._box.add_actor(this._scrollView);
        this._itemList = new St.BoxLayout({ style_class: 'login-dialog-session-item-list',
                                            vertical: true });
        this._scrollView.add_actor(this._itemList);
        this._scrollView.hide();
        this.isOpen = false;
        this._populate();
    },

    open: function() {
        if (this.isOpen)
            return;

        this._button.add_style_pseudo_class('open');
        this._scrollView.show();
        this._triangle.set_text('\u25BE');

        this.isOpen = true;
    },

    close: function() {
        if (!this.isOpen)
            return;

        this._button.remove_style_pseudo_class('open');
        this._scrollView.hide();
        this._triangle.set_text('\u25B8');

        this.isOpen = false;
    },

    _onClicked: function() {
        if (!this.isOpen)
            this.open();
        else
            this.close();
    },

    setActiveSession: function(sessionId) {
         if (sessionId == this._activeSessionId)
             return;

         if (this._activeSessionId)
             this._items[this._activeSessionId].setShowDot(false);

         this._items[sessionId].setShowDot(true);
         this._activeSessionId = sessionId;

         this.emit('session-activated', this._activeSessionId);
    },

    _populate: function() {
        this._itemList.destroy_all_children();
        this._activeSessionId = null;
        this._items = {};

        let ids = Gdm.get_session_ids();
        ids.sort();

        if (ids.length <= 1) {
            this._box.hide();
            this._button.hide();
        } else {
            this._button.show();
            this._box.show();
        }

        for (let i = 0; i < ids.length; i++) {
            let [sessionName, sessionDescription] = Gdm.get_session_name_and_description(ids[i]);

            let item = new SessionListItem(ids[i], sessionName);
            this._itemList.add_actor(item.actor);
            this._items[ids[i]] = item;

            if (!this._activeSessionId)
                this.setActiveSession(ids[i]);

            item.connect('activate',
                         Lang.bind(this, function() {
                             this.setActiveSession(item.id);
                         }));
        }
    }
});
Signals.addSignalMethods(SessionList.prototype);

const LoginDialog = new Lang.Class({
    Name: 'LoginDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function(parentActor) {
        this.parent({ shellReactive: true,
                      styleClass: 'login-dialog',
                      parentActor: parentActor
                    });
        this.connect('destroy',
                     Lang.bind(this, this._onDestroy));
        this.connect('opened',
                     Lang.bind(this, this._onOpened));

        this._userManager = AccountsService.UserManager.get_default()
        this._greeterClient = new Gdm.Client();

        this._greeter = this._greeterClient.get_greeter_sync(null);

        this._greeter.connect('default-session-name-changed',
                              Lang.bind(this, this._onDefaultSessionChanged));

        this._greeter.connect('session-opened',
                              Lang.bind(this, this._onSessionOpened));
        this._greeter.connect('timed-login-requested',
                              Lang.bind(this, this._onTimedLoginRequested));

        this._userVerifier = new GdmUtil.ShellUserVerifier(this._greeterClient);
        this._userVerifier.connect('ask-question', Lang.bind(this, this._askQuestion));
        this._userVerifier.connect('verification-failed', Lang.bind(this, this._onVerificationFailed));
        this._userVerifier.connect('reset', Lang.bind(this, this._onReset));

        this._userVerifier.connect('show-login-hint', Lang.bind(this, this._showLoginHint));
        this._userVerifier.connect('hide-login-hint', Lang.bind(this, this._hideLoginHint));

        this._settings = new Gio.Settings({ schema: GdmUtil.LOGIN_SCREEN_SCHEMA });

        this._settings.connect('changed::' + GdmUtil.LOGO_KEY,
                               Lang.bind(this, this._updateLogo));
        this._settings.connect('changed::' + GdmUtil.BANNER_MESSAGE_KEY,
                               Lang.bind(this, this._updateBanner));
        this._settings.connect('changed::' + GdmUtil.BANNER_MESSAGE_TEXT_KEY,
                               Lang.bind(this, this._updateBanner));

        this._logoBox = new St.Bin({ style_class: 'login-dialog-logo-box' });
        this.contentLayout.add(this._logoBox);
        this._updateLogo();

        this._bannerLabel = new St.Label({ style_class: 'login-dialog-banner',
                                           text: '' });
        this.contentLayout.add(this._bannerLabel);
        this._updateBanner();

        this._titleLabel = new St.Label({ style_class: 'login-dialog-title',
                                          text: C_("title", "Sign In") });

        this.contentLayout.add(this._titleLabel,
                              { y_fill: false,
                                y_align: St.Align.START });

        let mainContentBox = new St.BoxLayout({ vertical: false });
        this.contentLayout.add(mainContentBox,
                               { expand: true,
                                 x_fill: true,
                                 y_fill: false });

        this._userList = new UserList();
        mainContentBox.add(this._userList.actor,
                           { expand: true,
                             x_fill: true,
                             y_fill: true });

        this.setInitialKeyFocus(this._userList.actor);

        this._promptBox = new St.BoxLayout({ style_class: 'login-dialog-prompt-layout',
                                             vertical: true });
        mainContentBox.add(this._promptBox,
                           { expand: true,
                             x_fill: true,
                             y_fill: true,
                             x_align: St.Align.START });
        this._promptLabel = new St.Label({ style_class: 'login-dialog-prompt-label' });

        this._mainContentBox = mainContentBox;

        this._promptBox.add(this._promptLabel,
                            { expand: true,
                              x_fill: true,
                              y_fill: true,
                              x_align: St.Align.START });
        this._promptEntry = new St.Entry({ style_class: 'login-dialog-prompt-entry',
                                           can_focus: true });
        this._promptBox.add(this._promptEntry,
                            { expand: true,
                              x_fill: true,
                              y_fill: false,
                              x_align: St.Align.START });
        this._promptLoginHint = new St.Label({ style_class: 'login-dialog-prompt-login-hint-message' });
        this._promptLoginHint.hide();
        this._promptBox.add(this._promptLoginHint);

        this._sessionList = new SessionList();
        this._sessionList.connect('session-activated',
                                  Lang.bind(this, function(list, sessionId) {
                                                this._greeter.call_select_session_sync (sessionId, null);
                                            }));

        this._promptBox.add(this._sessionList.actor,
                            { expand: true,
                              x_fill: false,
                              y_fill: true,
                              x_align: St.Align.START });
        this._promptBox.hide();

        // translators: this message is shown below the user list on the
        // login screen. It can be activated to reveal an entry for
        // manually entering the username.
        let notListedLabel = new St.Label({ text: _("Not listed?"),
                                            style_class: 'login-dialog-not-listed-label' });
        this._notListedButton = new St.Button({ style_class: 'login-dialog-not-listed-button',
                                                can_focus: true,
                                                child: notListedLabel,
                                                reactive: true,
                                                x_align: St.Align.START,
                                                x_fill: true });

        this._notListedButton.connect('clicked', Lang.bind(this, this._onNotListedClicked));

        this.contentLayout.add(this._notListedButton,
                               { expand: false,
                                 x_align: St.Align.START,
                                 x_fill: true });

        if (!this._userManager.is_loaded)
            this._userManagerLoadedId = this._userManager.connect('notify::is-loaded',
                                                                  Lang.bind(this, function() {
                                                                      if (this._userManager.is_loaded) {
                                                                          this._loadUserList();
                                                                          this._userManager.disconnect(this._userManagerLoadedId);
                                                                          this._userManagerLoadedId = 0;
                                                                      }
                                                                  }));
        else
            this._loadUserList();

        this._userList.connect('activate',
                               Lang.bind(this, function(userList, item) {
                                   this._onUserListActivated(item);
                               }));

   },

    _updateLogo: function() {
        this._logoBox.child = null;
        let path = this._settings.get_string(GdmUtil.LOGO_KEY);

        if (path) {
            let file = Gio.file_new_for_path(path);
            let uri = file.get_uri();

            let textureCache = St.TextureCache.get_default();
            this._logoBox.child = textureCache.load_uri_async(uri, -1, _LOGO_ICON_NAME_SIZE);
        }

    },

    _updateBanner: function() {
        let enabled = this._settings.get_boolean(GdmUtil.BANNER_MESSAGE_KEY);
        let text = this._settings.get_string(GdmUtil.BANNER_MESSAGE_TEXT_KEY);

        if (enabled && text) {
            this._bannerLabel.set_text(text);
            this._fadeInBanner();
        } else {
            this._fadeOutBanner();
        }
    },

    _onReset: function(client, serviceName) {
        let tasks = [this._hidePrompt,

                     new Batch.ConcurrentBatch(this, [this._fadeInTitleLabel,
                                                      this._fadeInNotListedButton,
                                                      this._fadeInLogo]),

                     function() {
                         this._sessionList.close();
                         this._promptLoginHint.hide();
                         this._userList.actor.show();
                         this._userList.actor.opacity = 255;
                         return this._userList.showItems();
                     },

                     function() {
                         this._userList.actor.reactive = true;
                         this._userList.actor.grab_key_focus();
                     }];

        this._user = null;

        let batch = new Batch.ConsecutiveBatch(this, tasks);
        batch.run();
    },

    _onDefaultSessionChanged: function(client, sessionId) {
        this._sessionList.setActiveSession(sessionId);
    },

    _showLoginHint: function(verifier, message) {
        this._promptLoginHint.set_text(message)
        GdmUtil.fadeInActor(this._promptLoginHint);
    },

    _hideLoginHint: function() {
        GdmUtil.fadeOutActor(this._promptLoginHint);
        this._promptLoginHint.set_text('');
    },

    cancel: function() {
        this._userVerifier.cancel();
    },

    _fadeInPrompt: function() {
        let tasks = [function() {
                         return GdmUtil.fadeInActor(this._promptLabel);
                     },

                     function() {
                         return GdmUtil.fadeInActor(this._promptEntry);
                     },

                     function() {
                         // Show it with 0 opacity so we preallocate space for it
                         // in the event we need to fade in the message
                         this._promptLoginHint.opacity = 0;
                         this._promptLoginHint.show();
                     },

                     function() {
                         return GdmUtil.fadeInActor(this._promptBox);
                     },

                     function() {
                         if (this._user && this._user.is_logged_in())
                             return null;

                         return GdmUtil.fadeInActor(this._sessionList.actor);
                     },

                     function() {
                         this._promptEntry.grab_key_focus();
                     }];

        this._sessionList.actor.hide();
        let batch = new Batch.ConcurrentBatch(this, tasks);
        return batch.run();
    },

    _showPrompt: function() {
        let hold = new Batch.Hold();

        let buttons = [{ action: Lang.bind(this, this.cancel),
                         label: _("Cancel"),
                         key: Clutter.Escape },
                       { action: Lang.bind(this, function() {
                                     hold.release();
                                 }),
                         label: C_("button", "Sign In"),
                         default: true }];

        this._promptEntryActivateCallbackId = this._promptEntry.clutter_text.connect('activate',
                                                                                     Lang.bind(this, function() {
                                                                                         hold.release();
                                                                                     }));
        hold.connect('release', Lang.bind(this, function() {
                         this._promptEntry.clutter_text.disconnect(this._promptEntryActivateCallbackId);
                         this._promptEntryActivateCallbackId = null;
                     }));

        let tasks = [function() {
                         return this._fadeInPrompt();
                     },

                     function() {
                         this.setButtons(buttons);
                     },

                     hold];

        let batch = new Batch.ConcurrentBatch(this, tasks);

        return batch.run();
    },

    _hidePrompt: function() {
        if (this._promptEntryActivateCallbackId) {
            this._promptEntry.clutter_text.disconnect(this._promptEntryActivateCallbackId);
            this._promptEntryActivateCallbackId = null;
        }

        this.setButtons([]);

        let tasks = [function() {
                         return GdmUtil.fadeOutActor(this._promptBox);
                     },

                     function() {
                         this._promptLoginHint.hide();
                         this._promptEntry.reactive = true;
                         this._promptEntry.set_text('');
                     }];

        let batch = new Batch.ConsecutiveBatch(this, tasks);

        return batch.run();
    },

    _askQuestion: function(verifier, serviceName, question, passwordChar) {
        this._promptLabel.set_text(question);

        this._promptEntry.set_text('');
        this._promptEntry.clutter_text.set_password_char(passwordChar);

        let tasks = [this._showPrompt,

                     function() {
                         let _text = this._promptEntry.get_text();
                         this._promptEntry.reactive = false;
                         this._userVerifier.answerQuery(serviceName, _text);
                     }];

        let batch = new Batch.ConsecutiveBatch(this, tasks);
        return batch.run();
    },

    _onSessionOpened: function(client, serviceName) {
        this._greeter.call_start_session_when_ready_sync(serviceName, true, null);
    },

    _waitForItemForUser: function(userName) {
        let item = this._userList.getItemFromUserName(userName);

        if (item)
          return null;

        let hold = new Batch.Hold();
        let signalId = this._userList.connect('item-added',
                                              Lang.bind(this, function() {
                                                  let item = this._userList.getItemFromUserName(userName);

                                                  if (item)
                                                      hold.release();
                                              }));

        hold.connect('release', Lang.bind(this, function() {
                         this._userList.disconnect(signalId);
                     }));

        return hold;
    },

    _showTimedLoginAnimation: function() {
        this._timedLoginItem.actor.grab_key_focus();
        return this._timedLoginItem.showTimedLoginIndicator(this._timedLoginAnimationTime);
    },

    _blockTimedLoginUntilIdle: function() {
        // This blocks timed login from starting until a few
        // seconds after the user stops interacting with the
        // login screen.
        //
        // We skip this step if the timed login delay is very
        // short.
        if ((this._timedLoginDelay - _TIMED_LOGIN_IDLE_THRESHOLD) <= 0)
          return null;

        let hold = new Batch.Hold();

        this._timedLoginIdleTimeOutId = Mainloop.timeout_add_seconds(_TIMED_LOGIN_IDLE_THRESHOLD,
                                                                     function() {
                                                                         this._timedLoginAnimationTime -= _TIMED_LOGIN_IDLE_THRESHOLD;
                                                                         hold.release();
                                                                     });
        return hold;
    },

    _startTimedLogin: function(userName, delay) {
        this._timedLoginItem = null;
        this._timedLoginDelay = delay;
        this._timedLoginAnimationTime = delay;

        let tasks = [function() {
                         return this._waitForItemForUser(userName);
                     },

                     function() {
                         this._timedLoginItem = this._userList.getItemFromUserName(userName);
                     },

                     function() {
                         // If we're just starting out, start on the right
                         // item.
                         if (!this.is_loaded) {
                             this._userList.jumpToItem(this._timedLoginItem);
                         }
                     },

                     this._blockTimedLoginUntilIdle,

                     function() {
                         this._userList.scrollToItem(this._timedLoginItem);
                     },

                     this._showTimedLoginAnimation,

                     function() {
                         this._timedLoginBatch = null;
                         this._greeter.call_begin_auto_login_sync(userName, null);
                     }];

        this._timedLoginBatch = new Batch.ConsecutiveBatch(this, tasks);

        return this._timedLoginBatch.run();
    },

    _resetTimedLogin: function() {
        if (this._timedLoginBatch) {
            this._timedLoginBatch.cancel();
            this._timedLoginBatch = null;
        }

        if (this._timedLoginItem)
            this._timedLoginItem.hideTimedLoginIndicator();

        let userName = this._timedLoginItem.user.get_user_name();

        if (userName)
            this._startTimedLogin(userName, this._timedLoginDelay);
    },

    _onTimedLoginRequested: function(client, userName, seconds) {
        this._startTimedLogin(userName, seconds);

        global.stage.connect('captured-event',
                             Lang.bind(this, function(actor, event) {
                                if (this._timedLoginDelay == undefined)
                                    return false;

                                if (event.type() == Clutter.EventType.KEY_PRESS ||
                                    event.type() == Clutter.EventType.BUTTON_PRESS) {
                                    if (this._timedLoginBatch) {
                                        this._timedLoginBatch.cancel();
                                        this._timedLoginBatch = null;
                                    }
                                } else if (event.type() == Clutter.EventType.KEY_RELEASE ||
                                           event.type() == Clutter.EventType.BUTTON_RELEASE) {
                                    this._resetTimedLogin();
                                }

                                return false;
                             }));
    },

    _onVerificationFailed: function() {
        this._userVerifier.cancel();
    },

    _onNotListedClicked: function(user) {
        let tasks = [function() {
                         return this._userList.hideItems();
                     },

                     function() {
                         return this._userList.giveUpWhitespace();
                     },

                     function() {
                         this._userList.actor.hide();
                     },

                     new Batch.ConcurrentBatch(this, [this._fadeOutTitleLabel,
                                                      this._fadeOutNotListedButton,
                                                      this._fadeOutLogo]),

                     function() {
                         let hold = new Batch.Hold();

                         this._userVerifier.begin(null, hold);
                         return hold;
                     }];

        let batch = new Batch.ConsecutiveBatch(this, tasks);
        batch.run();
    },

    _fadeInLogo: function() {
        return GdmUtil.fadeInActor(this._logoBox);
    },

    _fadeOutLogo: function() {
        return GdmUtil.fadeOutActor(this._logoBox);
    },

    _fadeInBanner: function() {
        return GdmUtil.fadeInActor(this._bannerLabel);
    },

    _fadeOutBanner: function() {
        return GdmUtil.fadeOutActor(this._bannerLabel);
    },

    _fadeInTitleLabel: function() {
        return GdmUtil.fadeInActor(this._titleLabel);
    },

    _fadeOutTitleLabel: function() {
        return GdmUtil.fadeOutActor(this._titleLabel);
    },

    _fadeInNotListedButton: function() {
        return GdmUtil.fadeInActor(this._notListedButton);
    },

    _fadeOutNotListedButton: function() {
        return GdmUtil.fadeOutActor(this._notListedButton);
    },

    _beginVerificationForUser: function(userName) {
        let hold = new Batch.Hold();

        this._userVerifier.begin(userName, hold);
        return hold;
    },

    _onUserListActivated: function(activatedItem) {
        let userName;

        let tasks = [function() {
                         this._userList.actor.reactive = false;
                         return this._userList.pinInPlace();
                     },

                     function() {
                         return this._userList.hideItemsExcept(activatedItem);
                     },

                     function() {
                         return this._userList.giveUpWhitespace();
                     },

                     function() {
                         return activatedItem.fadeOutName();
                     },

                     new Batch.ConcurrentBatch(this, [this._fadeOutTitleLabel,
                                                      this._fadeOutNotListedButton,
                                                      this._fadeOutLogo]),

                     function() {
                         return this._userList.shrinkToNaturalHeight();
                     },

                     function() {
                         userName = activatedItem.user.get_user_name();

                         return this._beginVerificationForUser(userName);
                     }];

        this._user = activatedItem.user;

        let batch = new Batch.ConsecutiveBatch(this, tasks);
        batch.run();
    },

    _onDestroy: function() {
        if (this._userManagerLoadedId) {
            this._userManager.disconnect(this._userManagerLoadedId);
            this._userManagerLoadedId = 0;
        }
    },

    _loadUserList: function() {
        let users = this._userManager.list_users();

        for (let i = 0; i < users.length; i++) {
            this._userList.addUser(users[i]);
        }

        this._userManager.connect('user-added',
                                  Lang.bind(this, function(userManager, user) {
                                      this._userList.addUser(user);
                                  }));

        this._userManager.connect('user-removed',
                                  Lang.bind(this, function(userManager, user) {
                                      this._userList.removeUser(user);
                                  }));

        // emitted in idle so caller doesn't have to explicitly check if
        // it's loaded immediately after construction
        // (since there's no way the caller could be listening for
        // 'loaded' yet)
        Mainloop.idle_add(Lang.bind(this, function() {
            this.emit('loaded');
            this.is_loaded = true;
        }));
    },

    _onOpened: function() {
        Main.ctrlAltTabManager.addGroup(this._mainContentBox,
                                        _("Login Window"),
                                        'dialog-password',
                                        { sortGroup: CtrlAltTab.SortGroup.MIDDLE });

    },

    close: function() {
        this.parent();

        Main.ctrlAltTabManager.removeGroup(this._group);
    }
});
