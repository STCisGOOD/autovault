/**
 * WarpDither — WebGL warp dithering background effect.
 *
 * Inspired by paper.design/dithering. Uses Bayer 8x8 ordered dithering
 * over a slow domain-warped pattern in vellum tones. Speed ~0.2 for
 * calm, barely-perceptible animation.
 */

import { useRef, useEffect, memo } from 'react';

const VERT = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
in vec2 v_uv;
out vec4 fragColor;

float bayer8(vec2 p) {
  ivec2 ip = ivec2(mod(p, 8.0));
  int idx = ip.y * 8 + ip.x;
  const int b[64] = int[64](
    0,32,8,40,2,34,10,42,
    48,16,56,24,50,18,58,26,
    12,44,4,36,14,46,6,38,
    60,28,52,20,62,30,54,22,
    3,35,11,43,1,33,9,41,
    51,19,59,27,49,17,57,25,
    15,47,7,39,13,45,5,37,
    63,31,55,23,61,29,53,21
  );
  return float(b[idx]) / 64.0;
}

void main() {
  float t = 0.2 * 0.5 * u_time;

  float pxSize = 4.0;
  vec2 pxUV = floor(gl_FragCoord.xy / pxSize);
  vec2 normUV = (pxUV * pxSize + pxSize * 0.5) / u_resolution;
  vec2 shapeUV = (normUV - 0.5) * 3.0;
  shapeUV.x *= u_resolution.x / u_resolution.y;

  for (float i = 1.0; i < 6.0; i++) {
    shapeUV.x += 0.6 / i * cos(i * 2.5 * shapeUV.y + t);
    shapeUV.y += 0.6 / i * cos(i * 1.5 * shapeUV.x + t);
  }
  float shape = 0.15 / max(0.001, abs(sin(t - shapeUV.y - shapeUV.x)));
  shape = smoothstep(0.02, 1.0, shape);

  float dither = bayer8(pxUV) - 0.5;
  float res = step(0.5, shape + dither);

  vec3 bgColor = vec3(0.949, 0.918, 0.847);
  vec3 fgColor = vec3(0.918, 0.886, 0.816);
  vec3 color = mix(bgColor, fgColor, res);

  fragColor = vec4(color, 1.0);
}`;

function WarpDitherInner({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) return;

    // Compile shaders
    function compile(type: number, src: string) {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      return s;
    }

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('WarpDither shader link failed');
      return;
    }

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'a_position');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uRes = gl.getUniformLocation(prog, 'u_resolution');

    const startTime = performance.now();

    function render() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas!.clientWidth * dpr;
      const h = canvas!.clientHeight * dpr;
      if (canvas!.width !== w || canvas!.height !== h) {
        canvas!.width = w;
        canvas!.height = h;
        gl!.viewport(0, 0, w, h);
      }

      gl!.useProgram(prog);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, buf);
      gl!.enableVertexAttribArray(aPos);
      gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 0, 0);

      const elapsed = (performance.now() - startTime) / 1000.0;
      gl!.uniform1f(uTime, elapsed);
      gl!.uniform2f(uRes, canvas!.width, canvas!.height);

      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
      rafRef.current = requestAnimationFrame(render);
    }

    rafRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`block w-full h-full ${className ?? ''}`}
    />
  );
}

export default memo(WarpDitherInner);
