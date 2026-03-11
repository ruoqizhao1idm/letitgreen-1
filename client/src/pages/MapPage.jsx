import React, { useEffect } from "react";
import axios from "axios";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import { useNavigate } from "react-router-dom";
import { useApp } from "../state/AppContext.jsx";

const dublinCenter = [53.3438, -6.2546];

/**
 * 地图图标定义位置（可手动修改）：
 * - 本文件 MapPage.jsx：itemIcon, recycleIcon, recycleTcdIcon, yourLocationIcon（第 11-40 行）
 * - 样式 client/src/styles.css：.item-marker, .recycle-marker, .recycle-tcd-marker, .you-marker
 */

// 黄色标记：卖家发布的商品位置
const itemIcon = new L.DivIcon({
  className: "item-marker",
  html: "",
  iconSize: [24, 32],
  iconAnchor: [12, 32]
});

const recycleIcon = new L.DivIcon({
  className: "recycle-marker",
  html: "",
  iconSize: [24, 32],
  iconAnchor: [12, 32]
});

const recycleTcdIcon = new L.DivIcon({
  className: "recycle-tcd-marker",
  html: "",
  iconSize: [26, 34],
  iconAnchor: [13, 34]
});

const yourLocationIcon = new L.DivIcon({
  className: "you-marker",
  html: "●",
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});

const RECYCLE_POINTS = [
  {
    id: "recycle-tcd",
    name: "TCD Recycling Point (Trinity College Dublin)",
    lat: 53.3438,
    lng: -6.2546,
    isTcd: true
  },
  {
    id: "recycle-1",
    name: "DCC Recycling Centre",
    lat: 53.3465,
    lng: -6.2383
  },
  {
    id: "recycle-2",
    name: "Glass Bank",
    lat: 53.3378,
    lng: -6.2622
  }
];

export default function MapPage() {
  const { items, setItems } = useApp();
  const navigate = useNavigate();

  // 进入地图页时拉取商品列表，确保新添加的商品标记能显示
  useEffect(() => {
    const fetchItems = () => {
      axios.get("/api/items").then((res) => setItems(res.data || [])).catch(() => {});
    };
    fetchItems();
    // 每隔几秒刷新一次，方便刚发布后看到新商品（可选）
    const t = setInterval(fetchItems, 5000);
    return () => clearInterval(t);
  }, [setItems]);

  return (
    <div className="page map-page">
      <h2 className="section-title">Resource Map</h2>
      <div className="map-legend">
        <span className="legend-item">
          <span className="legend-dot item-dot" /> Listings (seller locations)
        </span>
        <span className="legend-item">
          <span className="legend-dot recycle-tcd-dot" /> TCD Recycling Point
        </span>
        <span className="legend-item">
          <span className="legend-dot recycle-dot" /> Other recycle points
        </span>
        <span className="legend-item">
          <span className="legend-dot you-dot" /> Your location
        </span>
      </div>
      <div className="map-wrapper">
        <MapContainer
          center={dublinCenter}
          zoom={14}
          scrollWheelZoom={false}
          className="leaflet-map"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <Marker position={dublinCenter} icon={yourLocationIcon}>
            <Popup>Your location (Trinity College Dublin area)</Popup>
          </Marker>

          {items.map((item) => {
            const lat = item.location?.lat ?? dublinCenter[0];
            const lng = item.location?.lng ?? dublinCenter[1];
            return (
              <Marker
                key={item.id}
                position={[lat, lng]}
                icon={itemIcon}
              >
                <Popup>
                  <div
                    className="map-popup map-popup-clickable"
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/items/${item.id}`)}
                    onKeyDown={(e) => e.key === "Enter" && navigate(`/items/${item.id}`)}
                  >
                    <img src={item.imageUrl} alt={item.title} />
                    <div className="map-popup-text">
                      <div className="map-popup-title">{item.title}</div>
                      <div className="map-popup-price">
                        {item.price}
                        <span>{item.currency || "€"}</span>
                      </div>
                      <span className="map-popup-link">View details →</span>
                    </div>
                  </div>
                </Popup>
              </Marker>
            );
          })}

          {RECYCLE_POINTS.map((p) => (
            <Marker
              key={p.id}
              position={[p.lat, p.lng]}
              icon={p.isTcd ? recycleTcdIcon : recycleIcon}
            >
              <Popup>{p.name}</Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

