// Color: higher contrast
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void mainImage(out vec4 f, in vec2 p) {
    vec4 c = texture(iChannel0, p / iResolution.xy);
    f = vec4(clamp((c.rgb - 0.5) * 1.4 + 0.5, 0.0, 1.0), c.a);
}
