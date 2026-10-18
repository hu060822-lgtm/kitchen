/**
 * 老周的頭像（原創、程式畫的 SVG）：高高的廚師帽、灰白的八字鬍、眼袋很深、臉頰貼著一塊 OK 繃。
 * talking：說話時嘴巴一開一合。
 */
export function MentorPortrait({ talking = false, size = 76 }: { talking?: boolean; size?: number }): JSX.Element {
  return (
    <svg className={`mentor-portrait ${talking ? 'talking' : ''}`} width={size} height={size} viewBox="0 0 80 80" role="img" aria-label="老周">
      <defs>
        <radialGradient id="mp-bg" cx="50%" cy="40%" r="70%">
          <stop offset="0" stopColor="#3a3226" />
          <stop offset="1" stopColor="#15120e" />
        </radialGradient>
      </defs>
      <rect width="80" height="80" rx="4" fill="url(#mp-bg)" />
      {/* 肩膀與廚師服 */}
      <path d="M8 80 C10 64 22 58 40 58 C58 58 70 64 72 80 Z" fill="#e7e2d6" />
      <path d="M40 58 L34 80 M40 58 L46 80" stroke="#b9b2a2" strokeWidth="1.4" />
      <circle cx="31" cy="68" r="1.6" fill="#8a7a5a" />
      <circle cx="49" cy="68" r="1.6" fill="#8a7a5a" />
      {/* 脖子 */}
      <rect x="34" y="50" width="12" height="10" fill="#b99d82" />
      {/* 臉 */}
      <path d="M24 34 C24 22 56 22 56 34 L55 44 C53 54 46 58 40 58 C34 58 27 54 25 44 Z" fill="#c9ab8e" />
      {/* 耳朵 */}
      <ellipse cx="24" cy="40" rx="3" ry="5" fill="#b99d82" />
      <ellipse cx="56" cy="40" rx="3" ry="5" fill="#b99d82" />
      {/* 鬢角（灰白） */}
      <path d="M24 32 L27 32 L27 42 L24 40 Z" fill="#9c968c" />
      <path d="M56 32 L53 32 L53 42 L56 40 Z" fill="#9c968c" />
      {/* 廚師帽 */}
      <rect x="25" y="24" width="30" height="7" fill="#f2efe6" />
      <path d="M25 26 C18 22 20 8 30 10 C32 2 48 2 50 10 C60 8 62 22 55 26 Z" fill="#f6f3ea" />
      <path d="M33 12 C34 18 34 22 34 25 M47 12 C46 18 46 22 46 25" stroke="#d8d3c6" strokeWidth="1.2" fill="none" />
      {/* 眉毛（濃、灰） */}
      <path d="M29 36 L36 35" stroke="#6f6a62" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M44 35 L51 36" stroke="#6f6a62" strokeWidth="2.4" strokeLinecap="round" />
      {/* 眼睛與眼袋 */}
      <ellipse cx="33" cy="40" rx="2" ry="1.4" fill="#1c1813" />
      <ellipse cx="47" cy="40" rx="2" ry="1.4" fill="#1c1813" />
      <path d="M30 43 Q33 44.6 36 43" stroke="#9e7f66" strokeWidth="1" fill="none" />
      <path d="M44 43 Q47 44.6 50 43" stroke="#9e7f66" strokeWidth="1" fill="none" />
      {/* 鼻子 */}
      <path d="M40 40 L38 47 L41 47.5" stroke="#9e7f66" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      {/* 八字鬍 */}
      <path d="M32 50 C35 47 39 48 40 49 C41 48 45 47 48 50 C45 51 42 50.5 40 50.5 C38 50.5 35 51 32 50 Z" fill="#a8a299" />
      {/* 嘴巴 */}
      <ellipse className="mp-mouth" cx="40" cy="53.2" rx="3" ry={talking ? 1.4 : 0.5} fill="#5a3a2c" />
      {/* 臉頰上的 OK 繃 */}
      <g transform="rotate(-18 51 47)">
        <rect x="47" y="45.5" width="8" height="3.2" rx="1.2" fill="#d9b48c" />
        <rect x="50" y="45.5" width="2" height="3.2" fill="#c49d74" />
      </g>
    </svg>
  );
}
