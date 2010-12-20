/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const GnomeBluetoothApplet = imports.gi.GnomeBluetoothApplet;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Shell = imports.gi.Shell;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;

const ConnectionState = {
    DISCONNECTED: 0,
    CONNECTED: 1,
    DISCONNECTING: 2,
    CONNECTING: 3
}

function Indicator() {
    this._init.apply(this, arguments);
}

Indicator.prototype = {
    __proto__: PanelMenu.SystemStatusButton.prototype,

    _init: function() {
        PanelMenu.SystemStatusButton.prototype._init.call(this, 'bluetooth-disabled', null);

        GLib.spawn_command_line_sync ('pkill -f "^bluetooth-applet$"');
        this._applet = new GnomeBluetoothApplet.Applet();

        this._killswitch = new PopupMenu.PopupSwitchMenuItem(_("Bluetooth"), false);
        this._applet.connect('notify::killswitch-state', Lang.bind(this, this._updateKillswitch));
        this._killswitch.connect('toggled', Lang.bind(this, function() {
            let current_state = this._applet.killswitch_state;
            if (current_state != GnomeBluetoothApplet.KillswitchState.HARD_BLOCKED &&
                current_state != GnomeBluetoothApplet.KillswitchState.NO_ADAPTER) {
                this._applet.killswitch_state = this._killswitch.state ?
                    GnomeBluetoothApplet.KillswitchState.UNBLOCKED:
                    GnomeBluetoothApplet.KillswitchState.SOFT_BLOCKED;
            } else
                this._killswitch.setToggleState(false);
        }));

        this._discoverable = new PopupMenu.PopupSwitchMenuItem(_("Visibility"), this._applet.discoverable);
        this._applet.connect('notify::discoverable', Lang.bind(this, function() {
            this._discoverable.setToggleState(this._applet.discoverable);
        }));
        this._discoverable.connect('toggled', Lang.bind(this, function() {
            this._applet.discoverable = this._discoverable.state;
        }));

        this._updateKillswitch();
        this.menu.addMenuItem(this._killswitch);
        this.menu.addMenuItem(this._discoverable);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._fullMenuItems = [new PopupMenu.PopupMenuItem(_("Send Files to Device...")),
                               new PopupMenu.PopupSeparatorMenuItem(),
                               new PopupMenu.PopupSeparatorMenuItem(),
                               new PopupMenu.PopupMenuItem(_("Setup a New Device..."))];
        this._deviceSep = this._fullMenuItems[1]; // hidden if no device exists

        this._fullMenuItems[0].connect('activate', function() {
            GLib.spawn_command_line_async('bluetooth-sendto');
        });
        this._fullMenuItems[3].connect('activate', function() {
            GLib.spawn_command_line_async('bluetooth-wizard');
        });

        for (let i = 0; i < this._fullMenuItems.length; i++) {
            let item = this._fullMenuItems[i];
            this.menu.addMenuItem(item);
        }

        this._deviceItemPosition = 5;
        this._deviceItems = [];
        this._applet.connect('devices-changed', Lang.bind(this, this._updateDevices));
        this._updateDevices();

        this._applet.connect('notify::show-full-menu', Lang.bind(this, this._updateFullMenu));
        this._updateFullMenu();

        this.menu.addAction(_("Bluetooth Settings"), function() {
            GLib.spawn_command_line_async('gnome-control-center bluetooth');
        });

        this._applet.connect('pincode-request', Lang.bind(this, this._pinRequest));
        this._applet.connect('confirm-request', Lang.bind(this, this._confirmRequest));
        this._applet.connect('auth-request', Lang.bind(this, this._authRequest));
        this._applet.connect('cancel-request', Lang.bind(this, this._cancelRequest));
    },

    _updateKillswitch: function() {
        let current_state = this._applet.killswitch_state;
        let on = current_state == GnomeBluetoothApplet.KillswitchState.UNBLOCKED;
        let can_toggle = current_state != GnomeBluetoothApplet.KillswitchState.NO_ADAPTER &&
                         current_state != GnomeBluetoothApplet.KillswitchState.HARD_BLOCKED;

        this._killswitch.setToggleState(on);
        this._killswitch.actor.reactive = can_toggle;

        if (on) {
            this._discoverable.actor.show();
            this.setIcon('bluetooth-active');
        } else {
            this._discoverable.actor.hide();
            this.setIcon('bluetooth-disabled');
        }
    },

    _updateDevices: function() {
        this._destroyAll(this._deviceItems);
        this._deviceItems = [];

        let devices = this._applet.get_devices();
        let anydevice = false;
        for (let i = 0; i < devices.length; i++) {
            let d = devices[i];
            let item = this._createDeviceItem(d);
            if (item) {
                this.menu.addMenuItem(item, this._deviceItemPosition + this._deviceItems.length);
                this._deviceItems.push(item);
                anydevice = true;
            }
        }
        if (anydevice)
            this._deviceSep.actor.show();
        else
            this._deviceSep.actor.hide();
    },

    _createDeviceItem: function(device) {
        if (!device.can_connect && device.capabilities == GnomeBluetoothApplet.Capabilities.NONE)
            return null;
        let item = new PopupMenu.PopupSubMenuMenuItem(device.alias);
        item._device = device;

        if (device.can_connect) {
            item._connected = device.connected;
            let menuitem = new PopupMenu.PopupSwitchMenuItem(_("Connection"), device.connected);

            menuitem.connect('toggled', Lang.bind(this, function() {
                if (item._connected > ConnectionState.CONNECTED) {
                    // operation already in progress, revert
                    menuitem.setToggleState(menuitem.state);
                }
                if (item._connected) {
                    item._connected = ConnectionState.DISCONNECTING;
                    this._applet.disconnect_device(item._device.device_path, function(applet, success) {
                        if (success) { // apply
                            item._connected = ConnectionState.DISCONNECTED;
                            menuitem.setToggleState(false);
                        } else { // revert
                            item._connected = ConnectionState.CONNECTED;
                            menuitem.setToggleState(true);
                        }
                    });
                } else {
                    item._connected = ConnectionState.CONNECTING;
                    this._applet.connect_device(item._device.device_path, function(applet, success) {
                        if (success) { // apply
                            item._connected = ConnectionState.CONNECTED;
                            menuitem.setToggleState(true);
                        } else { // revert
                            item._connected = ConnectionState.DISCONNECTED;
                            menuitem.setToggleState(false);
                        }
                    });
                }
            }));

            item.menu.addMenuItem(menuitem);
        }

        if (device.capabilities & GnomeBluetoothApplet.Capabilities.OBEX_PUSH) {
            item.menu.addAction(_("Send Files..."), Lang.bind(this, function() {
                this._applet.send_to_address(device.bdaddr, device.alias);
            }));
        }
        if (device.capabilities & GnomeBluetoothApplet.Capabilities.OBEX_FILE_TRANSFER) {
            item.menu.addAction(_("Browse Files..."), Lang.bind(this, function(event) {
                this._applet.browse_address(device.bdaddr, event.get_time(),
                    Lang.bind(this, function(applet, result) {
                        try {
                            applet.browse_address_finish(result);
                        } catch (e) {
                            this._ensureSource();
                            this._source.notify(new MessageTray.Notification(this._source,
                                 _("Bluetooth"),
                                 _("Error browsing device"),
                                 { body: _("The requested device cannot be browsed, error is '%s'").format(e) }));
                        }
                    }));
            }));
        }

        switch (device.type) {
        case GnomeBluetoothApplet.Type.KEYBOARD:
            item.menu.addAction(_("Keyboard Settings"), function() {
                GLib.spawn_command_line_async('gnome-control-center keyboard');
            });
            break;
        case GnomeBluetoothApplet.Type.MOUSE:
            item.menu.addAction(_("Mouse Settings"), function() {
                GLib.spawn_command_line_async('gnome-control-center mouse');
            });
            break;
        case GnomeBluetoothApplet.Type.HEADSET:
        case GnomeBluetoothApplet.Type.HEADPHONES:
        case GnomeBluetoothApplet.Type.OTHER_AUDIO:
            item.menu.addAction(_("Sound Settings"), function() {
                GLib.spawn_command_line_async('gnome-control-center sound');
            });
            break;
        default:
            break;
        }

        return item;
    },

    _updateFullMenu: function() {
        if (this._applet.show_full_menu) {
            this._showAll(this._fullMenuItems);
            this._showAll(this._deviceItems);
        } else {
            this._hideAll(this._fullMenuItems);
            this._hideAll(this._deviceItems);
        }
    },

    _showAll: function(items) {
        for (let i = 0; i < items.length; i++)
            items[i].actor.show();
    },

    _hideAll: function(items) {
        for (let i = 0; i < items.length; i++)
            items[i].actor.hide();
    },

    _destroyAll: function(items) {
        for (let i = 0; i < items.length; i++)
            items[i].destroy();
    },

    _ensureSource: function() {
        if (!this._source) {
            this._source = new Source();
            Main.messageTray.add(this._source);
        }
    },

    _authRequest: function(applet, device_path, name, long_name, uuid) {
        this._ensureSource();
        this._source.notify(new AuthNotification(this._source, this._applet, device_path, name, long_name, uuid));
    },

    _confirmRequest: function(applet, device_path, name, long_name, pin) {
        this._ensureSource();
        this._source.notify(new ConfirmNotification(this._source, this._applet, device_path, name, long_name, pin));
    },

    _pinRequest: function(applet, device_path, name, long_name, numeric) {
        this._ensureSource();
        this._source.notify(new PinNotification(this._source, this._applet, device_path, name, long_name, numeric));
    },

    _cancelRequest: function() {
        this._source.destroy();
    }
}

function Source() {
    this._init.apply(this, arguments);
}

Source.prototype = {
    __proto__: MessageTray.Source.prototype,

    _init: function() {
        MessageTray.Source.prototype._init.call(this, _("Bluetooth Agent"));

        this._setSummaryIcon(this.createNotificationIcon());
    },

    notify: function(notification) {
        this._private_destroyId = notification.connect('destroy', Lang.bind(this, function(notification) {
            if (this.notification == notification) {
                // the destroyed notification is the last for this source
                this.notification.disconnect(this._private_destroyId);
                this.destroy();
            }
        }));

        MessageTray.Source.prototype.notify.call(this, notification);
    },

    createNotificationIcon: function() {
        return new St.Icon({ icon_name: 'bluetooth-active',
                             icon_type: St.IconType.SYMBOLIC,
                             icon_size: this.ICON_SIZE });
    }
}

function AuthNotification() {
    this._init.apply(this, arguments);
}

AuthNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,

    _init: function(source, applet, device_path, name, long_name, uuid) {
        MessageTray.Notification.prototype._init.call(this,
                                                      source,
                                                      _("Bluetooth Agent"),
                                                      _("Authorization request from %s").format(name),
                                                      { customContent: true });
        this.setResident(true);

        this._applet = applet;
        this._devicePath = device_path;
        this.addBody(_("Device %s wants access to the service '%s'").format(long_name, uuid));

        this.addButton('always-grant', _("Always grant access"));
        this.addButton('grant', _("Grant this time only"));
        this.addButton('reject', _("Reject"));

        this.connect('action-invoked', Lang.bind(this, function(self, action) {
            switch (action) {
            case 'always-grant':
                this._applet.agent_reply_auth(this._devicePath, true, true);
                break;
            case 'grant':
                this._applet.agent_reply_auth(this._devicePath, true, false);
                break;
            case 'reject':
            default:
                this._applet.agent_reply_auth(this._devicePath, false, false);
            }
            this.destroy();
        }));
    }
}

function ConfirmNotification() {
    this._init.apply(this, arguments);
}

ConfirmNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,

    _init: function(source, applet, device_path, name, long_name, pin) {
        MessageTray.Notification.prototype._init.call(this,
                                                      source,
                                                      _("Bluetooth Agent"),
                                                      _("Pairing confirmation for %s").format(name),
                                                      { customContent: true });
        this.setResident(true);

        this._applet = applet;
        this._devicePath = device_path;
        this.addBody(_("Device %s wants to pair with this computer").format(long_name));
        this.addBody(_("Please confirm whether the PIN '%s' matches the one on the device.").format(pin));

        this.addButton('matches', _("Matches"));
        this.addButton('does-not-match', _("Does not match"));

        this.connect('action-invoked', Lang.bind(this, function(self, action) {
            if (action == 'matches')
                this._applet.agent_reply_confirm(this._devicePath, true);
            else
                this._applet.agent_reply_confirm(this._devicePath, false);
            this.destroy();
        }));
    }
}

function PinNotification() {
    this._init.apply(this, arguments);
}

PinNotification.prototype = {
    __proto__: MessageTray.Notification.prototype,

    _init: function(source, applet, device_path, name, long_name, numeric) {
        MessageTray.Notification.prototype._init.call(this,
                                                      source,
                                                      _("Bluetooth Agent"),
                                                      _("Pairing request for %s").format(name),
                                                      { customContent: true });
        this.setResident(true);

        this._applet = applet;
        this._devicePath = device_path;
        this._numeric = numeric;
        this.addBody(_("Device %s wants to pair with this computer").format(long_name));
        this.addBody(_("Please enter the PIN mentioned on the device."));

        this._entry = new St.Entry();
        this._entry.connect('key-release-event', Lang.bind(this, function(entry, event) {
            let key = event.get_key_symbol();
            if (key == Clutter.KEY_Return) {
                this.emit('action-invoked', 'ok');
                return true;
            } else if (key == Clutter.KEY_Escape) {
                this.emit('action-invoked', 'cancel');
                return true;
            }
            return false;
        }));
        this.addActor(this._entry);

        this.addButton('ok', _("Ok"));
        this.addButton('cancel', _("Cancel"));

        this.connect('action-invoked', Lang.bind(this, function(self, action) {
            if (action == 'ok') {
                if (this._numeric)
                    this._applet.agent_reply_passkey(this._devicePath, parseInt(this._entry.text));
                else
                    this._applet.agent_reply_pincode(this._devicePath, this._entry.text);
            } else {
                if (this._numeric)
                    this._applet.agent_reply_passkey(this._devicePath, -1);
                else
                    this._applet.agent_reply_pincode(this._devicePath, null);
            }
            this.destroy();
        }));
    },

    grabFocus: function(lockTray) {
        MessageTray.Notification.prototype.grabFocus.call(this, lockTray);
        global.stage.set_key_focus(this._entry);
    }
}