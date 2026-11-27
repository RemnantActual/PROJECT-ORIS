// Frame.clouds(): dark cloud banks creeping in from the screen edges
uniform sampler2D uTex;
uniform vec3 uT0, uT1, uT2;
uniform float uStrength, uReach;
uniform vec3 uCol;
void main() {
    vec3 im = img();
    float C = pil_sample(uTex, uT0, uT1, uT2);
    float a = clamp((C * 0.9 + eng().g * 1.25 * uReach - 1.05) * 2.6, 0.0, 1.0) * uStrength;
    fragColor = vec4(im * (1.0 - a) + a * uCol * (0.6 + 0.8 * C), 0.0);
}
