import type { Theme } from '@/types/theme';
import { withPrColors } from './prColors';

import amoled_dark_Raw from './amoled-dark.json';
import amoled_light_Raw from './amoled-light.json';
import arctic_dark_Raw from './arctic-dark.json';
import arctic_light_Raw from './arctic-light.json';
import aura_dark_Raw from './aura-dark.json';
import aura_light_Raw from './aura-light.json';
import ayu_dark_Raw from './ayu-dark.json';
import ayu_light_Raw from './ayu-light.json';
import blood_moon_dark_Raw from './blood-moon-dark.json';
import blood_moon_light_Raw from './blood-moon-light.json';
import carbonfox_dark_Raw from './carbonfox-dark.json';
import carbonfox_light_Raw from './carbonfox-light.json';
import catppuccin_dark_Raw from './catppuccin-dark.json';
import catppuccin_light_Raw from './catppuccin-light.json';
import dracula_dark_Raw from './dracula-dark.json';
import dracula_light_Raw from './dracula-light.json';
import everforest_dark_Raw from './everforest-dark.json';
import everforest_light_Raw from './everforest-light.json';
import flexoki_dark_Raw from './flexoki-dark.json';
import flexoki_light_Raw from './flexoki-light.json';
import github_dark_Raw from './github-dark.json';
import github_light_Raw from './github-light.json';
import gruvbox_dark_Raw from './gruvbox-dark.json';
import gruvbox_light_Raw from './gruvbox-light.json';
import kanagawa_dark_Raw from './kanagawa-dark.json';
import kanagawa_light_Raw from './kanagawa-light.json';
import lucent_orng_dark_Raw from './lucent-orng-dark.json';
import lucent_orng_light_Raw from './lucent-orng-light.json';
import matrix_dark_Raw from './matrix-dark.json';
import matrix_light_Raw from './matrix-light.json';
import mercury_dark_Raw from './mercury-dark.json';
import mercury_light_Raw from './mercury-light.json';
import nightowl_dark_Raw from './nightowl-dark.json';
import nightowl_light_Raw from './nightowl-light.json';
import nord_dark_Raw from './nord-dark.json';
import nord_light_Raw from './nord-light.json';
import oc_2_dark_Raw from './oc-2-dark.json';
import oc_2_light_Raw from './oc-2-light.json';
import one_dark_dark_Raw from './one-dark-dark.json';
import one_dark_light_Raw from './one-dark-light.json';
import opencode_dark_Raw from './opencode-dark.json';
import opencode_light_Raw from './opencode-light.json';
import orng_dark_Raw from './orng-dark.json';
import orng_light_Raw from './orng-light.json';
import osaka_jade_dark_Raw from './osaka-jade-dark.json';
import osaka_jade_light_Raw from './osaka-jade-light.json';
import palenight_dark_Raw from './palenight-dark.json';
import palenight_light_Raw from './palenight-light.json';
import rosepine_dark_Raw from './rosepine-dark.json';
import rosepine_light_Raw from './rosepine-light.json';
import solarized_dark_Raw from './solarized-dark.json';
import solarized_light_Raw from './solarized-light.json';
import synthesis_dark_Raw from './synthesis-dark.json';
import synthesis_light_Raw from './synthesis-light.json';
import synthwave84_dark_Raw from './synthwave84-dark.json';
import synthwave84_light_Raw from './synthwave84-light.json';
import tokyonight_dark_Raw from './tokyonight-dark.json';
import tokyonight_light_Raw from './tokyonight-light.json';
import tundra_dark_Raw from './tundra-dark.json';
import tundra_light_Raw from './tundra-light.json';
import vesper_dark_Raw from './vesper-dark.json';
import vesper_light_Raw from './vesper-light.json';

export const presetThemes: Theme[] = [
  amoled_dark_Raw as Theme,
  amoled_light_Raw as Theme,
  arctic_dark_Raw as Theme,
  arctic_light_Raw as Theme,
  aura_dark_Raw as Theme,
  aura_light_Raw as Theme,
  ayu_dark_Raw as Theme,
  ayu_light_Raw as Theme,
  blood_moon_dark_Raw as Theme,
  blood_moon_light_Raw as Theme,
  carbonfox_dark_Raw as Theme,
  carbonfox_light_Raw as Theme,
  catppuccin_dark_Raw as Theme,
  catppuccin_light_Raw as Theme,
  dracula_dark_Raw as Theme,
  dracula_light_Raw as Theme,
  everforest_dark_Raw as Theme,
  everforest_light_Raw as Theme,
  flexoki_dark_Raw as Theme,
  flexoki_light_Raw as Theme,
  github_dark_Raw as Theme,
  github_light_Raw as Theme,
  gruvbox_dark_Raw as Theme,
  gruvbox_light_Raw as Theme,
  kanagawa_dark_Raw as Theme,
  kanagawa_light_Raw as Theme,
  lucent_orng_dark_Raw as Theme,
  lucent_orng_light_Raw as Theme,
  matrix_dark_Raw as Theme,
  matrix_light_Raw as Theme,
  mercury_dark_Raw as Theme,
  mercury_light_Raw as Theme,
  nightowl_dark_Raw as Theme,
  nightowl_light_Raw as Theme,
  nord_dark_Raw as Theme,
  nord_light_Raw as Theme,
  oc_2_dark_Raw as Theme,
  oc_2_light_Raw as Theme,
  one_dark_dark_Raw as Theme,
  one_dark_light_Raw as Theme,
  opencode_dark_Raw as Theme,
  opencode_light_Raw as Theme,
  orng_dark_Raw as Theme,
  orng_light_Raw as Theme,
  osaka_jade_dark_Raw as Theme,
  osaka_jade_light_Raw as Theme,
  palenight_dark_Raw as Theme,
  palenight_light_Raw as Theme,
  rosepine_dark_Raw as Theme,
  rosepine_light_Raw as Theme,
  solarized_dark_Raw as Theme,
  solarized_light_Raw as Theme,
  synthesis_dark_Raw as Theme,
  synthesis_light_Raw as Theme,
  synthwave84_dark_Raw as Theme,
  synthwave84_light_Raw as Theme,
  tokyonight_dark_Raw as Theme,
  tokyonight_light_Raw as Theme,
  tundra_dark_Raw as Theme,
  tundra_light_Raw as Theme,
  vesper_dark_Raw as Theme,
  vesper_light_Raw as Theme,
].map((theme) => withPrColors(theme));
