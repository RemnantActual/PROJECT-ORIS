// bloom(): Pillow's resize(BILINEAR) on 8-bit RGB, one axis at a time, in Pillow's fixed point.
// uCoef row i = output pixel i: [first input px, count, weights * 2^22 ...] (oris_gpu.resize_coeffs)
// uThr >= 0: the source is the float frame and is thresholded first: uint8((img - thr) * 2 clipped to 0..1)
uniform sampler2D uSrc;
uniform isampler2D uCoef;
uniform int uAxis;
uniform float uThr;
ivec3 px8(ivec2 p) {
    vec3 v = texelFetch(uSrc, p, 0).rgb;
    if (uThr >= 0.0) return ivec3(clamp((v - uThr) * 2.0, 0.0, 1.0) * 255.0);
    return ivec3(round(v * 255.0));
}
void main() {
    ivec2 o = pix();
    int i = uAxis == 0 ? o.x : o.y;
    int x0 = texelFetch(uCoef, ivec2(0, i), 0).r;
    int n = texelFetch(uCoef, ivec2(1, i), 0).r;
    ivec3 acc = ivec3(1 << 21);
    for (int k = 0; k < n; k++) {
        ivec2 p = uAxis == 0 ? ivec2(x0 + k, o.y) : ivec2(o.x, x0 + k);
        acc += px8(p) * texelFetch(uCoef, ivec2(2 + k, i), 0).r;
    }
    vec3 r = vec3(clamp(acc >> 22, 0, 255));
    for (int c = 0; c < 3; c++) if (acc[c] >= (1 << 30)) r[c] = 255.0;
    fragColor = vec4(r / 255.0, 1.0);
}
