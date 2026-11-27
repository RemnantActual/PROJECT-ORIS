// ORIS GPU path — shared by every pass (oris_gpu.py puts this in front of each .frag).
// Each pass is the shader twin of a numpy function in oris.py; keep the two in step.
// Pixel (x, y) is image column x, row y (row 0 = top), exactly like the numpy arrays:
// gl_FragCoord.xy is the pixel centre (x + .5, y + .5), the same as Engine.X / Engine.Y.
#version 330

uniform vec2 uSize;               // frame size in px (W, H)
uniform vec3 uH0, uH1, uH2;       // inverse camera homography, rows (screen px -> world)
uniform sampler2D uImg;           // the frame so far (RGBA32F)
uniform sampler2D uEng;           // engine constants: r = vignette, g = edge, b = dots
out vec4 fragColor;

ivec2 pix() { return ivec2(gl_FragCoord.xy); }
vec3 img() { return texelFetch(uImg, pix(), 0).rgb; }
vec4 eng() { return texelFetch(uEng, pix(), 0); }

// Frame.world(): per-pixel world coordinates
vec2 world() {
    vec2 p = gl_FragCoord.xy;
    float den = uH2.x * p.x + uH2.y * p.y + uH2.z;
    return vec2((uH0.x * p.x + uH0.y * p.y + uH0.z) / den, (uH1.x * p.x + uH1.y * p.y + uH1.z) / den);
}

// Frame.rect_mask(): 1 inside a world rect (x0, y0, size), feathered to 0 at its edges
float rect_mask(vec3 r, float feather) {
    vec2 w = world();
    float u = (w.x - r.x) / r.z, v = (w.y - r.y) / r.z;
    float e = min(min(u, 1.0 - u), min(v, 1.0 - v));
    return clamp(e / feather, 0.0, 1.0);
}

// Pillow Image.transform(PERSPECTIVE/AFFINE, BILINEAR) on an 8-bit image:
// input point = (T0 . p) / (T2 . p) with p = (x + .5, y + .5, 1); 0 outside, edge-clamped inside,
// result truncated to 8 bits like Pillow does.
float pil_sample(sampler2D t, vec3 T0, vec3 T1, vec3 T2) {
    vec3 p = vec3(gl_FragCoord.xy, 1.0);
    float w = dot(T2, p);
    vec2 q = vec2(dot(T0, p), dot(T1, p)) / w;
    ivec2 n = textureSize(t, 0);
    if (q.x < 0.0 || q.y < 0.0 || q.x >= float(n.x) || q.y >= float(n.y)) return 0.0;
    q -= 0.5;
    vec2 f = floor(q);
    vec2 d = q - f;
    ivec2 i = ivec2(f);
    int x0 = clamp(i.x, 0, n.x - 1), x1 = clamp(i.x + 1, 0, n.x - 1);
    int y0 = clamp(i.y, 0, n.y - 1);
    float a = round(texelFetch(t, ivec2(x0, y0), 0).r * 255.0);
    float b = round(texelFetch(t, ivec2(x1, y0), 0).r * 255.0);
    float v1 = a + (b - a) * d.x;
    float v2 = v1;
    if (i.y + 1 >= 0 && i.y + 1 < n.y) {
        float c = round(texelFetch(t, ivec2(x0, i.y + 1), 0).r * 255.0);
        float e = round(texelFetch(t, ivec2(x1, i.y + 1), 0).r * 255.0);
        v2 = c + (e - c) * d.x;
    }
    return floor(v1 + (v2 - v1) * d.y) / 255.0;
}

// numpy's x % m for m > 0 (always 0 <= r < m)
float pymod(float x, float m) {
    float r = x - m * floor(x / m);
    if (r < 0.0) r += m;
    if (r >= m) r -= m;
    return r;
}
