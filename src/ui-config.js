// GET /api/ui-config (app-ux): the PC's GUI theme, delivered read-only so
// paired clients (the Android app) can match the desktop look. The values
// mirror muser-gui's Theme.xaml — the same tokens the app ships as its
// built-in defaults (android ui/Theme.kt) — and move here when the GUI's
// theme changes. The client validates every value before use
// (RemoteUiConfig.kt: schema, known keys, sane ranges) and keeps the
// built-in theme when the config is missing, stale or unusable, so this
// endpoint can never break a client that ignores it.
'use strict';

function buildUiConfig() {
  return {
    schema: 1,
    colors: {
      background: '#0E0E11',
      sidebar: '#0A0A0C',
      panel: '#131317',
      surface: '#17171C',
      chip: '#1E1E24',
      hover: '#12FFFFFF',
      selected: '#26FFFFFF',
      userBubble: '#292040',
      text: '#D4D4DA',
      muted: '#9A9AA3',
      progress: '#BDBDC5',
      faint: '#8B8B94',
      accent: '#B4A0FF',
      pink: '#FF8FC8',
      code: '#D0D0D6',
      codeBackground: '#08080A',
      ok: '#7BB88A',
      error: '#E5706B',
      warn: '#D9A95F',
      danger: '#F26B5E',
      diffAddBackground: '#16351F',
      diffAdd: '#A6E3B0',
      diffRemoveBackground: '#33161B',
      diffRemove: '#F2A7A7',
      line: '#38FFFFFF',
      lineSoft: '#24FFFFFF',
      composerActive: '#66B4A0FF',
    },
    fontSizes: {caption: 12, small: 13, body: 15, heading: 18, lineHeightBody: 24},
  };
}

module.exports = {buildUiConfig};
