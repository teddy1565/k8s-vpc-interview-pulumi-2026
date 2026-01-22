# VPC規劃

## 簡介

我的想法中，規劃了一個VPC，並建立了多個zone建立subnet，以確保HA和容錯能力。這樣的設計可以讓應用程式在不同的可用區域中運行，減少單點故障的風險

並且隔離了public和private subnet，以提升安全性。
Public subnet用於放置需要對外提供服務的資源，而private subnet則用於內部資源，這樣可以有效地保護敏感資料。

另外也同時規劃了NAT Gateway，以便private subnet中的資源能夠安全地訪問外部網路，同時保持內部網路的隔離

並且設置了VPN Gateway，嘗試實作類似GCP的IAP功能，允許遠端用戶安全地連接到VPC，進行維運與操作，使其達成安全性與便利性的平衡
