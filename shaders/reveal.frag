// Frame.reveal(): add a texture (contours) inside a world-space circle
uniform sampler2D uTex;
uniform vec3 uT0, uT1, uT2;
uniform int uHasRect;
uniform vec3 uRect, uCol;
uniform vec2 uC;
uniform float uR, uA, uSoft;
void main() {
    float c = pil_sample(uTex, uT0, uT1, uT2);
    if (uHasRect != 0) c = c * rect_mask(uRect, 0.08);
    vec2 w = world();
    float m = clamp((uR - length(w - uC)) / uSoft, 0.0, 1.0);
    fragColor = vec4(img() + (c * m * uA) * uCol, 0.0);
}
