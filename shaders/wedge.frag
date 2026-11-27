// Frame.wedge(): radar sweep with a fading trail
uniform vec2 uC;
uniform float uR, uAng, uWidth, uA;
uniform vec3 uCol;
void main() {
    vec3 im = img();
    vec2 dv = world() - uC;
    float d = length(dv);
    float behind = pymod(uAng - atan(dv.y, dv.x), 6.2831855);
    float trail = exp(-behind / uWidth) * clamp((uR - d) / (uR * 0.08), 0.0, 1.0);
    fragColor = vec4(im + (trail * uA) * uCol * (0.35 + im), 0.0);
}
