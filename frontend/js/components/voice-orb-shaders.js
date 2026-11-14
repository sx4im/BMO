// Procedural Bimo orange fog; no texture, video, or external assets.
export const vertexShader = `#version 300 es
precision highp float;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

export const fragmentShader = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform float uActivity;
uniform float uLevel;
uniform float uLow;
uniform float uMid;
out vec4 color;

// Reference palette and the broad lower cloud bank. Keep visual tuning here.
const vec3 BRAND_ORANGE = vec3(0.851, 0.467, 0.341); // --primary: #d97757
const vec3 LOWER_HAZE = vec3(1.0, 0.80, 0.66);
const vec3 CLOUD_WHITE = vec3(1.0, 0.97, 0.93);
const float BANK_SLOPE = -0.42;
const float CLOUD_SOFTNESS = 0.20;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.37, 0.73));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(
    mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
        mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
        mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float value = 0.0;
  float weight = 0.57;
  for (int i=0; i<3; i++) {
    value += noise(p) * weight;
    p = p * 2.03 + vec3(13.2, 7.1, 4.9);
    weight *= 0.46;
  }
  return value;
}

float fog(vec3 p) {
  vec3 drift = vec3(uTime * 0.55, -uTime * 0.36, uTime * 0.43);
  vec3 warp = vec3(noise(p*1.1 + drift),
                   noise(p*1.1 - drift.yzx + 8.0),
                   noise(p*1.1 + drift.zxy + 19.0));
  // Separate drift and deformation change the cloud itself instead of spinning it.
  return fbm(p * (1.65 + uMid*0.18) + (warp-0.5)*1.70 + drift*0.80 + 3.8);
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / min(uResolution.x,uResolution.y);
  uv /= 0.965 + uLow*0.009 + uLevel*0.005;
  float radius = length(uv);
  float aa = max(fwidth(radius)*1.3, 0.004);
  float mask = 1.0 - smoothstep(1.0-aa, 1.0, radius);
  if (mask <= 0.0) { color = vec4(0.0); return; }

  float depth = sqrt(max(0.0, 1.0-dot(uv,uv)));
  vec3 lightDirection = normalize(vec3(-0.5,0.7,1.1));
  vec3 front = vec3(uv, depth);
  float illumination = max(0.0, dot(front, lightDirection));
  // Haze reaches the lower silhouette instead of forming a dark blue rim.
  float hazeFlow = (noise(vec3(uv*1.3,uTime*0.5))-0.5)*0.55;
  vec3 atmosphere = mix(LOWER_HAZE, BRAND_ORANGE, smoothstep(-0.50,0.90,uv.y+hazeFlow));
  vec3 scattered = vec3(0.0);
  float transmission = 1.0;
  const int STEPS = 16;
  float stepLength = depth * 2.0 / float(STEPS);
  for (int i=0; i<STEPS; i++) {
    float z = depth - (float(i)+0.5)*stepLength;
    vec3 p = vec3(uv,z);
    float field = fog(p);
    float bankHeight = -0.04 + BANK_SLOPE*p.x
      + 0.24*sin(p.x*2.2 + uTime*0.80) + (field-0.48)*1.0;
    float cloud = smoothstep(-CLOUD_SOFTNESS,CLOUD_SOFTNESS,bankHeight-p.y+z*0.10);
    float density = cloud*(1.5+field*0.9+uLevel*0.18) + 0.012;
    float opacity = 1.0-exp(-density*stepLength*1.75);
    float softLight = 0.94 + 0.04*illumination + 0.01*z;
    vec3 mist = mix(LOWER_HAZE,CLOUD_WHITE,smoothstep(0.30,0.65,field));
    mist = mix(mist,LOWER_HAZE,smoothstep(0.10,0.85,-p.y)*0.65);
    mist *= softLight + uActivity*0.018 + uLevel*0.05;
    scattered += transmission * opacity * mist;
    transmission *= 1.0-opacity;
  }
  vec3 result = atmosphere*transmission + scattered;
  // Broad diffuse light keeps the volume luminous without a specular rim.
  result += vec3(0.04,0.025,0.018)*illumination*depth;
  color = vec4(clamp(result,0.0,1.0),mask);
}`;
