// Frame.map_layers(): halftone dots over the finished layers
uniform float uDots;
void main() {
    fragColor = vec4(img() * (1.0 - uDots * (1.0 - eng().b)), 0.0);
}
