// avs-presets.js — a starter set of Winamp AVS presets in Webvs JSON format.
//
// These use AVS "SuperScope" components (the classic oscilloscope/spectrum
// scripting) which webvs renders. It's a curated starter pack — the full AVS
// community scene has thousands of .avs presets that can be converted to this
// JSON format later with the `webvsc` converter.
//
// SuperScope code sections: init (run once), perFrame (each frame),
// onBeat (on a detected beat), perPoint (per plotted point; i=0..1, v=sample).

export const AVS_PRESETS = [
  {
    name: 'AVS · Oscilloscope',
    preset: {
      clearFrame: true,
      components: [
        {
          type: 'SuperScope',
          source: 'WAVEFORM',
          code: { init: 'n=512;', perPoint: 'x=i*2-1;y=v*0.75;' },
          colors: ['#21e6c1'],
          thickness: 2,
          drawMode: 'LINES',
        },
      ],
    },
  },
  {
    name: 'AVS · Spectrum',
    preset: {
      clearFrame: true,
      components: [
        {
          type: 'SuperScope',
          source: 'SPECTRUM',
          code: { init: 'n=128;', perPoint: 'x=i*2-1;y=-1+v*3;' },
          colors: ['#7b5cff', '#21e6c1'],
          thickness: 2,
          drawMode: 'LINES',
        },
      ],
    },
  },
  {
    name: 'AVS · Circle Scope',
    preset: {
      clearFrame: true,
      components: [
        {
          type: 'SuperScope',
          source: 'WAVEFORM',
          code: { init: 'n=256;', perPoint: 'd=i*6.28318;r=0.4+v*0.35;x=cos(d)*r;y=sin(d)*r;' },
          colors: ['#ffffff', '#21e6c1'],
          thickness: 2,
          drawMode: 'LINES',
        },
      ],
    },
  },
  {
    name: 'AVS · Vortex',
    preset: {
      clearFrame: true,
      components: [
        {
          type: 'SuperScope',
          source: 'WAVEFORM',
          code: {
            init: 'n=256;t=0;',
            perFrame: 't=t+0.02;',
            perPoint: 'd=i*6.28318+t;r=0.2+v*0.5;x=cos(d*3)*r;y=sin(d*2)*r;',
          },
          colors: ['#ff4d9d', '#7b5cff'],
          thickness: 2,
          drawMode: 'LINES',
        },
      ],
    },
  },
  {
    name: 'AVS · Beat Bloom',
    preset: {
      clearFrame: true,
      components: [
        {
          type: 'SuperScope',
          source: 'WAVEFORM',
          code: {
            init: 'n=256;sz=0.3;',
            onBeat: 'sz=0.65;',
            perFrame: 'sz=sz*0.94+0.3*0.06;',
            perPoint: 'd=i*6.28318;r=sz+v*0.3;x=cos(d)*r;y=sin(d)*r;',
          },
          colors: ['#ffb020', '#ff4d9d'],
          thickness: 3,
          drawMode: 'LINES',
        },
      ],
    },
  },
  {
    name: 'AVS · Twin Scopes',
    preset: {
      clearFrame: true,
      components: [
        {
          type: 'SuperScope',
          source: 'WAVEFORM',
          code: { init: 'n=256;', perPoint: 'x=i*2-1;y=0.4+v*0.4;' },
          colors: ['#21e6c1'],
          thickness: 2,
          drawMode: 'LINES',
        },
        {
          type: 'SuperScope',
          source: 'SPECTRUM',
          code: { init: 'n=128;', perPoint: 'x=i*2-1;y=-0.4-v*2.5;' },
          colors: ['#7b5cff'],
          thickness: 2,
          drawMode: 'LINES',
        },
      ],
    },
  },
];
