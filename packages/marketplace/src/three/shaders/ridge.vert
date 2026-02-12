/**
 * Ridge vertex shader — displaces a flat ribbon by weight-driven height data.
 * Vertex colors are passed through for the fragment shader.
 */

varying vec3 vColor;
varying float vEdgeFade;

void main() {
  vColor = color;

  // UV.x maps to position along the ridge (0→1)
  // Edge fade for the window function glow effect
  vEdgeFade = sin(uv.x * 3.14159265);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
