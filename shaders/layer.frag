// Frame.map_layers(): one layer over the ones below it
uniform sampler2D uTex;
uniform vec3 uT0, uT1, uT2;
uniform float uGain, uA, uFeather;
uniform int uHasRect;
uniform vec3 uRect, uTint;
void main() {
    float m = pil_sample(uTex, uT0, uT1, uT2) * uGain;
    float mask = uHasRect != 0 ? uA * rect_mask(uRect, uFeather) : uA;
    fragColor = vec4(img() * (1.0 - mask) + (m * mask) * uTint, 0.0);
}
