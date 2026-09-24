import {loadFont as loadFraunces} from '@remotion/google-fonts/Fraunces';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';
import {loadFont as loadPlex} from '@remotion/google-fonts/IBMPlexMono';

const fraunces = loadFraunces();
const inter = loadInter();
const plex = loadPlex();

export const FRAUNCES = fraunces.fontFamily;
export const INTER = inter.fontFamily;
export const MONO = plex.fontFamily;