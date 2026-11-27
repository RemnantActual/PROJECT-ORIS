// Frame.zone(): tinted disk on the map
uniform vec2 uC;
uniform float uR, uFill, uPpw, uSoftPx;
uniform vec3 uCol;
void main() {
    vec3 im = img();
    float d = length(world() - uC);
    float m = clamp((uR - d) * uPpw / uSoftPx, 0.0, 1.0);
    float q = clamp(d / uR, 0.0, 1.0);
    float k = m * uFill * (0.45 + 0.55 * (q * q * q * q));
    fragColor = vec4(im * (1.0 - k) + k * uCol * (0.22 + 1.7 * im), 0.0);
}
