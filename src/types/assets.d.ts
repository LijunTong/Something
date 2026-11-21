// 静态音频资源声明：Vite 会把 mp3 编译成带哈希的资源地址
declare module '*.mp3' {
  const src: string
  export default src
}
