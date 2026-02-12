/**
 * Ridge fragment shader — applies fitness-based color with edge glow.
 */

varying vec3 vColor;
varying float vEdgeFade;

void main() {
  // Base color from vertex colors (fitness gradient)
  vec3 col = vColor;

  // Edge glow: brighten peaks, dim edges
  float glow = 0.8 + 0.2 * vEdgeFade;
  col *= glow;

  // Emissive-like brightness boost for higher fitness values
  float luminance = dot(col, vec3(0.299, 0.587, 0.114));
  col += col * luminance * 0.3;

  gl_FragColor = vec4(col, 0.9 * vEdgeFade + 0.1);
}
