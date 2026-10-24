// jsdom ships no types and @types/jsdom isn't installed; the storefront tests only use `new JSDOM(html, options)`.
declare module 'jsdom';
