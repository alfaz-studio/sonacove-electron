// Shared scoped electron-log logger for the overlay feature. Entries land in
// the same main-process log file as the auto-updater (see main.js) and are
// prefixed with "(overlay)" so the show-path can be traced in a mixed log.
module.exports = require('electron-log').scope('overlay');
