'use strict'

function desktopMode(platform = process.platform, env = process.env) {
  const wayland = platform === 'linux' && (!!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland')
  return { wayland, floating: !wayland || !!env.DISPLAY, xwayland: wayland && !!env.DISPLAY }
}

module.exports = { desktopMode }
