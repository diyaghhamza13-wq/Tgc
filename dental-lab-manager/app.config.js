// Allows hosting the web build under a sub-path (e.g. GitHub Pages: /Tgc/app)
// via EXPO_BASE_URL, without affecting local development or native builds.
module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    ...(process.env.EXPO_BASE_URL ? { baseUrl: process.env.EXPO_BASE_URL } : {}),
  },
});
