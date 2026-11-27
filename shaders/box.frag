// bloom(): one pass of Pillow's box blur (GaussianBlur = 3 passes per axis), same integer math
uniform sampler2D uSrc;
uniform int uAxis, uRad;
uniform uint uWW, uFW;
uvec3 px8(int k) {
    ivec2 o = pix();
    ivec2 n = textureSize(uSrc, 0);
    ivec2 p = uAxis == 0 ? ivec2(clamp(o.x + k, 0, n.x - 1), o.y) : ivec2(o.x, clamp(o.y + k, 0, n.y - 1));
    return uvec3(round(texelFetch(uSrc, p, 0).rgb * 255.0));
}
void main() {
    uvec3 acc = uvec3(0u);
    for (int k = -uRad; k <= uRad; k++) acc += px8(k);
    uvec3 bulk = acc * uWW + (px8(-uRad - 1) + px8(uRad + 1)) * uFW;
    fragColor = vec4(vec3((bulk + (1u << 23)) >> 24) / 255.0, 1.0);
}
