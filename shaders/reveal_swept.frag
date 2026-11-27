// Frame.reveal_swept(): reveal a texture in the wake of a sweep
uniform sampler2D uTex;
uniform vec3 uT0, uT1, uT2;
uniform vec2 uC;
uniform float uR, uA0, uSwept, uA;
uniform vec3 uCol;
void main() {
    float c = pil_sample(uTex, uT0, uT1, uT2);
    vec2 dv = world() - uC;
    float d = length(dv);
    float done = pymod(atan(dv.y, dv.x) - uA0, 6.2831855) <= uSwept ? 1.0 : 0.0;
    float m = done * clamp((uR - d) / (uR * 0.06), 0.0, 1.0);
    fragColor = vec4(img() + (c * m * uA) * uCol, 0.0);
}
