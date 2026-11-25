// Run: npm test   (Node strips the types natively)
import assert from 'node:assert/strict';
import { newLayer, insertFrame, insertKeyframe, clearKeyframe, removeFrame, moveKeyframe, layerLen, kfIndexAt, frameEls, newTween, cubicBezier, matchPaths, ident, instFrame, pairEls, type ShapeEl, type SymbolEl } from './model.ts';
import { ellipsePath, rectPath, pathBounds, rdp } from './geom.ts';

const shape = (id: string, x: number): ShapeEl => ({ id, kind: 'shape', tf: ident(x, 0), alpha: 1, path: rectPath(-5, -5, 10, 10), fill: '#ff0000ff', stroke: null, sw: 1 });

// timeline ops
const l = newLayer('t');
l.kfs[0].els.push(shape('a', 0));
insertFrame(l, 9); assert.equal(layerLen(l), 10);
const k = insertKeyframe(l, 9, false); assert.equal(l.kfs.length, 2); assert.equal(k.els[0].id, 'a', 'F6 keeps ids for tween matching');
k.els[0].tf.x = 90;
l.kfs[0].tween = newTween();
assert.equal(frameEls(l, 3).els[0].tf.x, 30, 'linear tween midpoint');
assert.equal(frameEls(l, 9).els[0].tf.x, 90);
const mid = insertKeyframe(l, 5, false); assert.equal(mid.els[0].tf.x, 50, 'auto-key bakes interpolated value');
assert.equal(frameEls(l, 7).els[0].tf.x, 70, 'tween still continuous after split');
assert.equal(moveKeyframe(l, 1, 2), 2); assert.equal(kfIndexAt(l, 6), 0);
clearKeyframe(l, 7); assert.equal(l.kfs.length, 2);
removeFrame(l, 0); assert.equal(layerLen(l), 9);
insertKeyframe(l, 20, true); assert.equal(layerLen(l), 21); assert.equal(l.kfs.at(-1)!.els.length, 0, 'F7 past end is blank');

// easing + morph + instances
assert.ok(Math.abs(cubicBezier(0.5, [0.42, 0, 0.58, 1]) - 0.5) < 1e-4);
assert.ok(cubicBezier(0.25, [0.42, 0, 1, 1]) < 0.25, 'ease-in starts slow');
const [a, b] = matchPaths(rectPath(0, 0, 10, 10), ellipsePath(0, 0, 5, 5));
assert.equal(a.nodes.length, b.nodes.length);
const [c, d] = matchPaths(rectPath(0, 0, 10, 10), { closed: true, nodes: ellipsePath(0, 0, 5, 5).nodes.concat(ellipsePath(9, 9, 1, 1).nodes) });
assert.equal(c.nodes.length, 8); assert.equal(d.nodes.length, 8);
const bb = pathBounds(ellipsePath(0, 0, 5, 3)); assert.ok(Math.abs(bb.w - 10) < 0.05 && Math.abs(bb.h - 6) < 0.05);
assert.equal(rdp([{ x: 0, y: 0 }, { x: 1, y: 0.01 }, { x: 2, y: 0 }], 0.1).length, 2);
const inst = { loop: 'loop', first: 2 } as SymbolEl;
assert.equal(instFrame(inst, 5, 4), 3); assert.equal(instFrame({ ...inst, loop: 'once' }, 5, 4), 3); assert.equal(instFrame({ ...inst, loop: 'single' }, 5, 4), 2);
assert.equal(pairEls([shape('x', 0)], [shape('y', 0)])[0]?.id, 'y', 'unmatched shapes pair by order (shape tween)');
console.log('selftest ok');
