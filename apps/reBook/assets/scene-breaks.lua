local function has_class(el, class_name)
  if not el or not el.attr or not el.attr.classes then
    return false
  end

  for _, cls in ipairs(el.attr.classes) do
    if cls == class_name then
      return true
    end
  end
  return false
end

local function has_any_class(el, class_names)
  for _, class_name in ipairs(class_names) do
    if has_class(el, class_name) then
      return true
    end
  end
  return false
end

local function paragraph_text(block)
  if not block then
    return ""
  end
  return pandoc.utils.stringify(block):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
end

local function is_scene_break_marker(block)
  if not block or (block.t ~= "Para" and block.t ~= "Plain") then
    return false
  end
  local compact = pandoc.utils.stringify(block):gsub("%s+", "")
  return compact == "***"
end

local function is_header_level_one(block)
  return block and block.t == "Header" and block.level == 1
end

local function is_story_title_header(block)
  return is_header_level_one(block) and has_class(block, "story-title")
end

local function is_interlude_title_header(block)
  return is_header_level_one(block) and has_class(block, "interlude-title")
end

local function is_semantic_title_header(block)
  return is_header_level_one(block)
    and has_any_class(block, { "story-title", "interlude-title" })
end

local function is_book_page_div(block)
  return block and block.t == "Div" and has_class(block, "book-page")
end

local function is_docx_page_break_block(block)
  if not block or block.t ~= "RawBlock" then
    return false
  end
  if block.format ~= "openxml" then
    return false
  end
  if not block.text then
    return false
  end
  return block.text:find('w:type="page"', 1, true) ~= nil
    or block.text:find("<w:pageBreakBefore", 1, true) ~= nil
end

local function make_docx_page_break_block()
  return pandoc.RawBlock(
    "openxml",
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
  )
end

local function make_scene_break()
  local content = {
    pandoc.Str("*"),
    pandoc.Space(),
    pandoc.Str("*"),
    pandoc.Space(),
    pandoc.Str("*"),
  }

  local div_attr = pandoc.Attr("", { "scene-break" })
  if FORMAT:match("docx") then
    div_attr.attributes["custom-style"] = "Scene Break"
  end

  return pandoc.Div({ pandoc.Para(content) }, div_attr)
end

local function make_first_paragraph(block)
  if not block or (block.t ~= "Para" and block.t ~= "Plain") then
    return block
  end

  local inlines = block.c
  local para = pandoc.Para(inlines, pandoc.Attr("", { "first-after-scene-break", "first-after-title" }))
  if FORMAT:match("docx") then
    return pandoc.Div(
      { para },
      pandoc.Attr("", { "first-after-scene-break" }, { ["custom-style"] = "First Paragraph" })
    )
  end

  return para
end

local function style_book_page_div(div)
  local styled_blocks = {}

  for _, block in ipairs(div.content) do
    if block.t == "Header" then
      local classes = {}
      for _, cls in ipairs(block.attr.classes) do
        table.insert(classes, cls)
      end
      table.insert(classes, "book-page-title")
      local attrs = {}
      for k, v in pairs(block.attr.attributes) do
        attrs[k] = v
      end

      if FORMAT:match("docx") then
        local style_name = block.level == 1 and "Book Page Title" or "Book Page Subheading"
        table.insert(
          styled_blocks,
          pandoc.Div(
            { pandoc.Para(block.content) },
            pandoc.Attr(block.attr.identifier, classes, { ["custom-style"] = style_name })
          )
        )
      else
        table.insert(styled_blocks, pandoc.Header(block.level, block.content, pandoc.Attr(block.attr.identifier, classes, attrs)))
      end
    elseif block.t == "Para" or block.t == "Plain" then
      table.insert(styled_blocks, pandoc.Para(block.c, pandoc.Attr("", { "book-page-text" })))
    else
      table.insert(styled_blocks, block)
    end
  end

  local classes = {}
  for _, cls in ipairs(div.attr.classes) do
    table.insert(classes, cls)
  end
  local attrs = {}
  for k, v in pairs(div.attr.attributes) do
    attrs[k] = v
  end

  if FORMAT:match("docx") then
    attrs["custom-style"] = "Book Page"
  end

  return pandoc.Div(styled_blocks, pandoc.Attr(div.attr.identifier, classes, attrs))
end

-- The hidden navigation label follows the book language. Russian books get a Russian label.
local function interlude_label(meta)
  local lang = ""
  if meta and meta.lang then
    lang = pandoc.utils.stringify(meta.lang):lower()
  end
  if lang:match("^ru") then
    return "Интерлюдия"
  end
  return "Interlude"
end

local function style_semantic_title_header(header, interlude_counter, label)
  if FORMAT:match("docx") then
    local style_name = "Story Title"
    if is_story_title_header(header) then
      style_name = "Story Title"
    elseif is_interlude_title_header(header) then
      style_name = "Interlude Title"
    end
    return pandoc.Div(
      { pandoc.Para(header.content) },
      pandoc.Attr(header.attr.identifier, header.attr.classes, { ["custom-style"] = style_name })
    )
  end

  if FORMAT:match("epub") and is_interlude_title_header(header) then
    local nav_hint = pandoc.Span(
      { pandoc.Space(), pandoc.Str(label), pandoc.Space(), pandoc.Str(tostring(interlude_counter)) },
      pandoc.Attr("", { "interlude-nav-label" })
    )
    table.insert(header.content, nav_hint)
  end

  return header
end

function Pandoc(doc)
  local out = {}
  local first_after_scene_break_pending = false
  local first_after_title_pending = false
  local interlude_counter = 0
  local previous_significant = nil
  local blocks = doc.blocks
  local label = interlude_label(doc.meta)

  local function next_significant_block(start_index)
    for i = start_index, #blocks do
      local b = blocks[i]
      if b and b.t ~= "Null" then
        return b
      end
    end
    return nil
  end

  for index, block in ipairs(blocks) do
    if is_scene_break_marker(block) then
      local next_significant = next_significant_block(index + 1)
      local suppress = is_header_level_one(previous_significant)
        or is_book_page_div(previous_significant)
        or is_header_level_one(next_significant)
        or is_book_page_div(next_significant)
      if not suppress then
        table.insert(out, make_scene_break())
        first_after_scene_break_pending = true
        first_after_title_pending = false
        previous_significant = { t = "SceneBreak" }
      end
    else
      if is_book_page_div(block) then
        table.insert(out, style_book_page_div(block))
        if FORMAT:match("docx") then
          local next_significant = next_significant_block(index + 1)
          local should_add_break_after = next_significant ~= nil
            and not is_book_page_div(next_significant)
            and not is_semantic_title_header(next_significant)
            and not is_docx_page_break_block(next_significant)
          if should_add_break_after then
            table.insert(out, make_docx_page_break_block())
          end
        end
        first_after_scene_break_pending = false
        first_after_title_pending = false
        previous_significant = block
      elseif is_semantic_title_header(block) then
        if is_interlude_title_header(block) then
          interlude_counter = interlude_counter + 1
        end
        table.insert(out, style_semantic_title_header(block, interlude_counter, label))
        first_after_scene_break_pending = false
        first_after_title_pending = true
        previous_significant = block
      elseif is_header_level_one(block) then
        table.insert(out, block)
        first_after_scene_break_pending = false
        first_after_title_pending = false
        previous_significant = block
      elseif first_after_scene_break_pending then
        if block.t == "Para" or block.t == "Plain" then
          if paragraph_text(block) == "" then
            table.insert(out, block)
          else
            table.insert(out, make_first_paragraph(block))
            first_after_scene_break_pending = false
            previous_significant = block
          end
        else
          table.insert(out, block)
          if block.t ~= "Null" then
            previous_significant = block
          end
        end
      elseif first_after_title_pending then
        if block.t == "Para" or block.t == "Plain" then
          if paragraph_text(block) == "" then
            table.insert(out, block)
          else
            table.insert(out, make_first_paragraph(block))
            first_after_title_pending = false
            previous_significant = block
          end
        else
          table.insert(out, block)
          if block.t ~= "Null" then
            previous_significant = block
          end
        end
      else
        table.insert(out, block)
        if block.t ~= "Null" then
          previous_significant = block
        end
      end
    end
  end

  return pandoc.Pandoc(out, doc.meta)
end
