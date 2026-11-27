// Frame.map(): one map texture through the camera, tinted, with the halftone dots
uniform sampler2D uTex;
uniform vec3 uT0, uT1, uT2;
uniform float uGain, uDots;
uniform vec3 uTint;
void main() {
    float m = pil_sample(uTex, uT0, uT1, uT2) * uGain;
    if (uDots != 0.0) m *= 1.0 - uDots * (1.0 - eng().b);
    fragColor = vec4(m * uTint, 0.0);
}
