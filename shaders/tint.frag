// Frame.tint()
uniform vec3 uCol;
uniform float uAmount;
void main() {
    vec3 im = img();
    fragColor = vec4(im * (1.0 - uAmount) + im * uCol * uAmount * 1.4, 0.0);
}
