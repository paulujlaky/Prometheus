// Animation configs..

export const EASE_GLIDE = [0.22, 1, 0.36, 1] as const;

export const fadeUp = {

  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
  transition: { duration: 0.24, ease: EASE_GLIDE },

};

export const popIn = {

  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
  transition: { duration: 0.2, ease: EASE_GLIDE },

};

export const fade = {

  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.16, ease: EASE_GLIDE },

};

export const slideIn = {

  initial: { opacity: 0, scale: 0.86, x: 8 },
  animate: { opacity: 1, scale: 1, x: 0 },
  exit: { opacity: 0, scale: 0.86, x: 8 },
  transition: { duration: 0.24, ease: EASE_GLIDE },

};
