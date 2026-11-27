// Frame.light(): pool of light around a world point
uniform vec2 uC;
uniform float uSigma, uAmb, uGainL;
void main() {
    vec2 w = world();
    float d2 = ((w.x - uC.x) * (w.x - uC.x) + (w.y - uC.y) * (w.y - uC.y)) / (uSigma * uSigma);
    fragColor = vec4(img() * (uAmb + uGainL * exp(-d2)), 0.0);
}
