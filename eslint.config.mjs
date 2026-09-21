import iobrokerConfig from '@iobroker/eslint-config';

export default [
    {
        ignores: ['bundledPlugins/**', 'admin/**', 'node_modules/**'],
    },
    ...iobrokerConfig,
];
