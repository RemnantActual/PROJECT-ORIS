// Frame.finish(): lay an overlay (premultiplied RGBA, 8-bit) over the frame.
// uSS = 2: the overlay is the 2x supersampled canvas, shrunk here exactly like Pillow's Image.reduce(2) does
// for RGBA (to RGBa, 2x2 box average, back to RGBA), all in integers.
uniform sampler2D uOv;
uniform int uSS;
uniform float uK, uG;

uvec4 texel(ivec2 p) { return uvec4(round(texelFetch(uOv, p, 0) * 255.0)); }

uvec4 rgba2rgbA(uvec4 c) {   // Pillow MULDIV255(c, a)
    uvec3 t = c.rgb * c.a + 128u;
    return uvec4(((t >> 8) + t) >> 8, c.a);
}

vec4 overlay() {
    if (uSS != 2) return texelFetch(uOv, pix(), 0);
    ivec2 p = pix() * 2;
    uvec4 s = (rgba2rgbA(texel(p)) + rgba2rgbA(texel(p + ivec2(1, 0))) + rgba2rgbA(texel(p + ivec2(0, 1)))
               + rgba2rgbA(texel(p + ivec2(1, 1))) + 2u) >> 2;
    uvec3 rgb = s.rgb;
    if (s.a != 0u && s.a != 255u) rgb = min((255u * s.rgb) / s.a, uvec3(255u));
    return vec4(vec3(rgb), float(s.a)) / 255.0;
}

void main() {
    vec4 o = overlay();
    fragColor = vec4(img() * (1.0 - o.a * uK) + o.rgb * uG * uK, 0.0);
}
