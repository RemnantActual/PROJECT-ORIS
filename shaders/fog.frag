// Frame.fog(): screen-space cloud bank (fly-through)
uniform sampler2D uTex;
uniform vec3 uT0, uT1, uT2;
uniform float uAmount, uK;
uniform vec3 uCol;
void main() {
    vec3 im = img();
    float C = pil_sample(uTex, uT0, uT1, uT2);
    float a = clamp((C - (1.0 - uAmount) * 1.05) * 3.0, 0.0, 1.0) * uK;
    fragColor = vec4(im * (1.0 - a) + a * uCol * (0.7 + 0.4 * C), 0.0);
}
