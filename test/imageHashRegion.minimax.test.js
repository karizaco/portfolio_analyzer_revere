'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveFractionalRegion
} = require('../src/video/imageHashRegion');

test('resolveFractionalRegion accepts the xFraction/yFraction/wFraction/hFraction shape', () => {
  const region = resolveFractionalRegion(480, 270, {
    xFraction: 0.70,
    yFraction: 0.84,
    wFraction: 0.28,
    hFraction: 0.14
  });

  assert.deepEqual(region, {
    x: 336,
    y: 227,
    width: 134,
    height: 38
  });
});
