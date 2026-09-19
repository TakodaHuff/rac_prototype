// Build script: bundles engine-bundle-src.js (json-rules-engine) into
// vendor/json-rules-engine.bundle.js. Run with `npm run build:engine`
// after `npm install`. Requires webpack (devDependency, see package.json).
const path = require('path');
const webpack = require('webpack');

const compiler = webpack({
  entry: path.join(__dirname, 'engine-bundle-src.js'),
  mode: 'production',
  target: 'web',
  output: {
    filename: 'json-rules-engine.bundle.js',
    path: path.join(__dirname, 'vendor'),
  },
});

compiler.run((err, stats) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(stats.toString({ colors: false }));
  compiler.close(() => {
    if (stats.hasErrors()) process.exit(1);
  });
});
