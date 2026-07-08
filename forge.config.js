const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// CRM client — same Electron Forge + Vite shell as the status monitor, with the
// CRM modules assembled on the canonical dashboard canvas.
module.exports = {
  packagerConfig: {
    name: 'CRM',
    appId: 'com.redstone.crm',
    asar: true,
    extraResource: ['dashboard'],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'CRM',
        authors: 'Redstone',
        setupExe: 'CRM-Setup.exe',
        noMsi: true,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // Main process + the single preload used by the main window. No renderer
        // entry: the window is loaded from a static file (loadFile), so there is
        // no Vite dev-server renderer to build. icons.js / tickets.js / auth.js are
        // imported by main.js and inlined by the main bundle.
        build: [
          { entry: 'electron/main.js', config: 'vite.main.config.js', target: 'main' },
          { entry: 'electron/dashboard-preload.js', config: 'vite.preload.config.js', target: 'preload' },
        ],
        renderer: [],
      },
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};
