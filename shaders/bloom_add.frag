// bloom(): last (vertical) step of both upscales, then img + (g1 * .6 + g2 * .4) / 255 * strength
uniform sampler2D uG1, uG2;
uniform isampler2D uCoef;
uniform float uStrength;
vec3 up(sampler2D g) {
    ivec2 o = pix();
    int y0 = texelFetch(uCoef, ivec2(0, o.y), 0).r;
    int n = texelFetch(uCoef, ivec2(1, o.y), 0).r;
    ivec3 acc = ivec3(1 << 21);
    for (int k = 0; k < n; k++)
        acc += ivec3(round(texelFetch(g, ivec2(o.x, y0 + k), 0).rgb * 255.0)) * texelFetch(uCoef, ivec2(2 + k, o.y), 0).r;
    vec3 r = vec3(clamp(acc >> 22, 0, 255));
    for (int c = 0; c < 3; c++) if (acc[c] >= (1 << 30)) r[c] = 255.0;
    return r;
}
void main() {
    fragColor = vec4(img() + (up(uG1) * 0.6 + up(uG2) * 0.4) / 255.0 * uStrength, 0.0);
}
