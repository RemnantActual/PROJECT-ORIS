// Frame.finish(): boot reveal edge and the bright scan line
uniform int uReveal, uScan;
uniform float uEdge, uScanY, uS;
uniform vec3 uPale;
void main() {
    vec3 im = img();
    float Y = gl_FragCoord.y;
    if (uReveal != 0) im = im * clamp((uEdge - Y) / (14.0 * uS), 0.0, 1.0);
    if (uScan != 0) {
        float d = abs(Y - uScanY) / uS;
        im = im + (exp(-d / 1.2) * 0.9 + exp(-d / 18.0) * 0.18) * uPale;
    }
    fragColor = vec4(im, 0.0);
}
