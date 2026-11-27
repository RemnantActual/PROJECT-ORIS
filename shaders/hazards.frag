// Frame.hazards(): clouds blooming out of world points (xy = point, z = current radius)
uniform sampler2D uTex;
uniform vec3 uT0, uT1, uT2;
uniform vec3 uEm[64];
uniform int uN;
uniform vec3 uCol;
void main() {
    vec3 im = img();
    float N = pil_sample(uTex, uT0, uT1, uT2);
    vec2 w = world();
    float A = 0.0;
    for (int i = 0; i < uN; i++) {
        float fall = clamp(1.0 - length(w - uEm[i].xy) / uEm[i].z, 0.0, 1.0);
        A = max(A, clamp((fall * 1.25 + N * 1.0 - 1.05) * 1.7, 0.0, 1.0) * (0.55 + 0.45 * fall));
    }
    float speck = clamp((N - 0.62) * 6.0, 0.0, 1.0);
    fragColor = vec4(im * (1.0 - 0.6 * A) + A * uCol * (0.25 + 0.95 * N) * (1.0 - 0.5 * speck), 0.0);
}
