const path = require('path');

module.exports = {
  plugins: {
    tailwindcss: {
      // Ensure CI/build runners resolve the app-level Tailwind config (and its content globs).
      config: path.join(__dirname, 'tailwind.config.js'),
    },
    autoprefixer: {},
  },
};
