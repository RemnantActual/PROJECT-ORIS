// Frame.finish(): vignette, flicker, film grain, fade, 8-bit output
uniform sampler2D uNoise;
uniform float uFlick, uFade;
void main() {
    vec3 im = img() * eng().r;
    im *= uFlick;
    im += (texelFetch(uNoise, pix(), 0).r * 0.028) * (0.35 + im);
    im *= uFade;
    fragColor = vec4(floor(clamp(im, 0.0, 1.0) * 255.0 + 0.5) / 255.0, 1.0);
}
