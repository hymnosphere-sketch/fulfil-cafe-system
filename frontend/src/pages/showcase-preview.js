import 'bootstrap/js/dist/collapse.js'
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Coffee,
  Info,
  Package,
  Plus,
  Search,
  Settings,
  TriangleAlert,
  createIcons,
} from 'lucide'
import { initializePreviewForm } from '../components/preview-form.js'
import { renderPreviewLayout } from '../layouts/preview-layout.js'
import { renderDesignShowcase } from './design-showcase.js'

export function showDesignShowcase(app) {
  document.title = 'Modern Café Design Showcase | Fulfil Cafe'
  app.innerHTML = renderPreviewLayout(renderDesignShowcase())
  initializePreviewForm(app.querySelector('#preview-form'))
  createIcons({
    root: app,
    icons: { ChevronDown, CircleAlert, CircleCheck, Coffee, Info, Package, Plus, Search, Settings, TriangleAlert },
  })
}
