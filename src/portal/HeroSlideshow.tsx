import { useEffect, useState } from 'react'

// Diaporama décoratif du hero de connexion : fondu enchaîné entre plusieurs
// paysages (montagnes, fjords, vues aériennes) avec un léger zoom lent
// (effet Ken Burns). Images servies depuis `public/hero/`.
const SLIDES = [
  '/hero/01-geirangerfjord.jpg',
  '/hero/04-turquoise-lake.jpg',
  '/hero/03-mountain-range.jpg',
  '/hero/06-glacial-lake.jpg',
  '/hero/02-fjord-autumn.jpg',
  '/hero/05-aerial-golden.jpg',
]
const INTERVAL_MS = 6000

export default function HeroSlideshow() {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const id = window.setInterval(
      () => setIndex((current) => (current + 1) % SLIDES.length),
      INTERVAL_MS,
    )
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="auth-slideshow" aria-hidden="true">
      {SLIDES.map((src, i) => (
        <div
          key={src}
          className={`auth-slide${i === index ? ' is-active' : ''}`}
          style={{ backgroundImage: `url('${src}')` }}
        />
      ))}
    </div>
  )
}
